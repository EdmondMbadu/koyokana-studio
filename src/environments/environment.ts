import { AppEnvironment } from './environment.model';
import { baseEnvironment } from './environment.base';

// Real Firebase project. Nonsecret settings live in environment.base.ts;
// the build replaces firebase-key.ts with the generated, ignored local module.
export const environment: AppEnvironment = baseEnvironment;
