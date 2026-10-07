import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ConfirmHost } from './ui/confirm-host';
import { ToastHost } from './ui/toast-host';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, ToastHost, ConfirmHost],
  template: `
    <router-outlet />
    <app-toast-host />
    <app-confirm-host />
  `,
})
export class App {}
