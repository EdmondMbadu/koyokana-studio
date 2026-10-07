import { Routes } from '@angular/router';
import { adminGuard, guestGuard, memberGuard, pendingGuard, reviewerGuard } from './core/guards';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in · Koyokana Studio',
    loadComponent: () => import('./pages/auth/login').then((m) => m.Login),
  },
  {
    path: 'pending',
    canActivate: [pendingGuard],
    title: 'Awaiting access · Koyokana Studio',
    loadComponent: () => import('./pages/auth/pending').then((m) => m.Pending),
  },
  {
    path: '',
    canActivate: [memberGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      {
        path: '',
        pathMatch: 'full',
        title: 'Home · Koyokana Studio',
        loadComponent: () => import('./pages/home/home').then((m) => m.Home),
      },
      {
        path: 'record',
        title: 'Record · Koyokana Studio',
        loadComponent: () => import('./pages/record/record').then((m) => m.Record),
      },
      {
        path: 'review',
        canActivate: [reviewerGuard],
        title: 'Review · Koyokana Studio',
        loadComponent: () => import('./pages/review/review').then((m) => m.Review),
      },
      {
        path: 'script',
        canActivate: [adminGuard],
        title: 'Script · Koyokana Studio',
        loadComponent: () => import('./pages/script/script').then((m) => m.Script),
      },
      {
        path: 'datasets',
        canActivate: [adminGuard],
        title: 'Datasets · Koyokana Studio',
        loadComponent: () => import('./pages/datasets/datasets').then((m) => m.Datasets),
      },
      {
        path: 'training',
        canActivate: [adminGuard],
        title: 'Training · Koyokana Studio',
        loadComponent: () => import('./pages/training/training').then((m) => m.Training),
      },
      {
        path: 'team',
        canActivate: [adminGuard],
        title: 'Team · Koyokana Studio',
        loadComponent: () => import('./pages/team/team').then((m) => m.Team),
      },
      {
        path: 'settings',
        title: 'Settings · Koyokana Studio',
        loadComponent: () => import('./pages/settings/settings').then((m) => m.Settings),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
