import { AppEnvironment } from './environment.model';
import { baseEnvironment as prod } from './environment.base';

// `ng serve -c emulator` — talks to local Firebase emulators instead of production.
export const environment: AppEnvironment = {
  ...prod,
  production: false,
  useEmulators: true,
  firebase: { ...prod.firebase, projectId: 'demo-koyokana', storageBucket: 'demo-koyokana.appspot.com' },
  gcp: { ...prod.gcp, projectId: 'demo-koyokana' },
};
