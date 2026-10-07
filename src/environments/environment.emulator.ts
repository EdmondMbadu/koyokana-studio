import { AppEnvironment } from './environment.model';
import { baseEnvironment as prod } from './environment.base';

// `ng serve -c emulator` — talks to local Firebase emulators instead of production.
export const environment: AppEnvironment = {
  ...prod,
  production: false,
  useEmulators: true,
  firebase: {
    apiKey: 'demo-koyokana-key',
    authDomain: 'demo-koyokana.firebaseapp.com',
    projectId: 'demo-koyokana',
    storageBucket: 'demo-koyokana.appspot.com',
    messagingSenderId: '000000000000',
    appId: '1:000000000000:web:demo-koyokana',
  },
  gcp: { ...prod.gcp, projectId: 'demo-koyokana' },
};
