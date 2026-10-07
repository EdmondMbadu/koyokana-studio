export interface AppEnvironment {
  production: boolean;
  useEmulators: boolean;
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
    measurementId?: string;
  };
  ownerEmails: string[];
  gcp: { projectId: string; region: string; artifactRepo: string };
  goalsHours: number[];
}
