import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** Signed-in users with an active role. */
export const memberGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.settle();
  if (!auth.user()) {
    return router.createUrlTree(['/login'], state.url === '/' ? {} : { queryParams: { next: state.url } });
  }
  if (!auth.isMember()) return router.createUrlTree(['/pending']);
  return true;
};

// Note: inject() must run before the first await (injection context).
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.settle();
  return auth.isAdmin() ? true : router.createUrlTree(['/']);
};

export const reviewerGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.settle();
  return auth.isReviewer() ? true : router.createUrlTree(['/']);
};

/** Login page: send signed-in users onwards. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.settle();
  if (!auth.user()) return true;
  return router.createUrlTree([auth.isMember() ? '/' : '/pending']);
};

/** Pending page: only for signed-in users without access. */
export const pendingGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  await auth.settle();
  if (!auth.user()) return router.createUrlTree(['/login']);
  if (auth.isMember()) return router.createUrlTree(['/']);
  return true;
};
