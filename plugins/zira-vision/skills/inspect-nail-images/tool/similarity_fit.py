"""Bounded similarity/affine registration on reserved fitting pixels."""
import numpy as np

CONFIG = dict(maxIterations=40, maxBacktracks=10, maxStepPx=1.,
              stableStepPx=.05, stableIterations=3, minEigenRatio=.001,
              damping=1e-6, scoreTolerance=1e-12)


def matrix_for(parameters, shape, model='similarity'):
    """Parameters are center translation and radius-scaled scale/rotation."""
    h,w=shape
    radius=float(max(h,w));cx,cy=(w-1)/2.,(h-1)/2.
    if model=='affine':
        tx,ty,qxx,qxy,qyx,qyy=parameters
        a,b,c,d=1.+qxx/radius,qxy/radius,qyx/radius,1.+qyy/radius
        return np.array([[a,b,cx-a*cx-b*cy+tx],
                         [c,d,cy-c*cx-d*cy+ty],[0.,0.,1.]])
    if model!='similarity':
        raise ValueError('unknown direct registration model')
    tx,ty,qa,qb=parameters
    a,b=1.+qa/radius,qb/radius
    return np.array([[a,-b,cx-a*cx+b*cy+tx],
                     [b,a,cy-b*cx-a*cy+ty],[0.,0.,1.]])


def corner_change(first,second,shape):
    h,w=shape
    points=np.array([[0.,0.,1.],[w-1.,0.,1.],[w-1.,h-1.,1.],[0.,h-1.,1.]])
    return float(np.max(np.linalg.norm(points@(second-first)[:2].T,axis=1)))


def bilinear(image, x, y):
    """Return values and exact derivatives of the bilinear interpolant."""
    ix,iy=np.floor(x).astype(int),np.floor(y).astype(int)
    if np.any(ix<0) or np.any(iy<0) or np.any(ix+1>=image.shape[1]) or np.any(iy+1>=image.shape[0]):
        raise ValueError('similarity sampling outside image')
    dx,dy=x-ix,y-iy
    p00,p10=image[iy,ix],image[iy,ix+1]
    p01,p11=image[iy+1,ix],image[iy+1,ix+1]
    values=p00*(1-dx)*(1-dy)+p10*dx*(1-dy)+p01*(1-dx)*dy+p11*dx*dy
    gx=(p10-p00)*(1-dy)+(p11-p01)*dy
    gy=(p01-p00)*(1-dx)+(p11-p10)*dx
    return values,gx,gy


def fit(reference,target,mask,seed,guard,model='similarity'):
    """Maximize masked zero-mean correlation with a monotone guarded search.

    Inputs are already filtered. The caller owns fitting/validation separation.
    Every trial is checked by guard before target pixels are sampled. Nothing
    outside mask contributes to the objective, Jacobian, or convergence test.
    """
    cfg=CONFIG
    if model not in ('similarity','affine'):
        raise ValueError('unknown direct registration model')
    count=6 if model=='affine' else 4
    make_matrix=lambda p:matrix_for(p,reference.shape,model)
    shape=reference.shape;h,w=shape;radius=float(max(shape))
    if not np.isfinite(seed).all() or not np.allclose(seed[:2,:2],np.eye(2),atol=1e-12):
        return None,dict(reason=model+'_seed_must_be_translation')
    parameters=np.zeros(count)
    parameters[:2]=seed[:2,2]
    matrix=make_matrix(parameters)
    if not guard(matrix,shape):
        return None,dict(reason=model+'_seed_outside_guard')
    ys,xs=np.nonzero(mask)
    if len(xs)<count:
        return None,dict(reason=model+'_insufficient_support')
    rx=(xs-(w-1)/2.)/radius;ry=(ys-(h-1)/2.)/radius
    ref=reference[ys,xs].astype(float);ref-=ref.mean()
    sigma=float(np.sqrt(np.mean(ref*ref)))
    if sigma<1e-8:
        return None,dict(reason=model+'_weak_texture')
    ref/=sigma

    def evaluate(p,derivatives=False):
        if model=='similarity':
            tx,ty,qa,qb=p
            values,gx,gy=bilinear(target,xs+tx+qa*rx-qb*ry,ys+ty+qb*rx+qa*ry)
        else:
            tx,ty,qxx,qxy,qyx,qyy=p
            values,gx,gy=bilinear(target,xs+tx+qxx*rx+qxy*ry,ys+ty+qyx*rx+qyy*ry)
        values=values-values.mean()
        std=float(np.sqrt(np.mean(values*values)))
        if std<1e-8:
            return -1.,None,None
        z=values/std
        score=float(np.mean(ref*z))
        if not derivatives:return score,None,None
        jac=(np.column_stack([gx,gy,gx*rx+gy*ry,-gx*ry+gy*rx]) if model=='similarity'
             else np.column_stack([gx,gy,gx*rx,gx*ry,gy*rx,gy*ry]))
        jac-=jac.mean(axis=0)
        jac=(jac-z[:,None]*np.mean(z[:,None]*jac,axis=0))/std
        return score,z-ref,jac

    score,residual,jac=evaluate(parameters,True)
    diag=dict(initialScore=score,iterations=0,stableSteps=0,rejectedTrials=0,
              objectiveScores=[score])
    stable=0
    for iteration in range(cfg['maxIterations']):
        diag['iterations']=iteration+1
        if jac is None:
            return None,dict(diag,reason=model+'_weak_target_texture')
        hessian=jac.T@jac/len(xs)
        norms=np.sqrt(np.maximum(np.diag(hessian),1e-12))
        normalized=hessian/np.outer(norms,norms)
        eig=np.linalg.eigvalsh(normalized)
        ratio=float(max(eig[0],0)/max(eig[-1],1e-12))
        diag['parameterEigenRatio']=ratio
        if ratio<cfg['minEigenRatio']:
            return None,dict(diag,reason=model+'_underconstrained')
        gradient=jac.T@residual/len(xs)
        try:
            step=-np.linalg.solve(hessian+cfg['damping']*np.diag(np.maximum(np.diag(hessian),1e-9)),gradient)
        except np.linalg.LinAlgError:
            return None,dict(diag,reason=model+'_singular_step')
        if not np.isfinite(step).all():
            return None,dict(diag,reason=model+'_nonfinite_step')
        raw_step=corner_change(matrix,make_matrix(parameters+step),shape)
        diag['rawCornerStepPx']=raw_step
        if raw_step>cfg['maxStepPx']:
            step*=cfg['maxStepPx']/raw_step
        accepted=False
        sampled_trials=0
        for backtrack in range(cfg['maxBacktracks']):
            trial_parameters=parameters+step*(.5**backtrack)
            trial=make_matrix(trial_parameters)
            if not guard(trial,shape):
                diag['rejectedTrials']+=1
                continue
            trial_score,_,_=evaluate(trial_parameters)
            sampled_trials+=1
            if trial_score+cfg['scoreTolerance']>=score:
                accepted=True
                break
        if not accepted:
            if sampled_trials==0:
                return None,dict(diag,reason=model+'_all_trials_outside_guard')
            # A tiny requested step with no measurable score gain is convergence;
            # a large step shrunk against a bound is not.
            if raw_step<=cfg['stableStepPx']:
                trial_parameters=parameters;trial=matrix;trial_score=score
            else:
                return None,dict(diag,reason=model+'_no_improving_step')
        change=corner_change(matrix,trial,shape)
        stable=stable+1 if raw_step<=cfg['stableStepPx'] and change<=cfg['stableStepPx'] else 0
        parameters,matrix=trial_parameters,trial
        score,residual,jac=evaluate(parameters,True)
        diag.update(stableSteps=stable,lastCornerStepPx=change,finalScore=score)
        diag['objectiveScores'].append(score)
        if stable>=cfg['stableIterations']:
            if model=='affine':
                return matrix,dict(diag,reason='',converged=True,
                    singularValues=np.linalg.svd(matrix[:2,:2],compute_uv=False).tolist(),
                    determinant=float(np.linalg.det(matrix[:2,:2])))
            scale=float(np.hypot(matrix[0,0],matrix[1,0]))
            angle=float(np.degrees(np.arctan2(matrix[1,0],matrix[0,0])))
            return matrix,dict(diag,reason='',scale=scale,rotationDegrees=angle,converged=True)
    return None,dict(diag,reason=model+'_iteration_limit',converged=False)
