import { ApplicationConfig } from '@angular/core';
import { provideClientHydration } from '@angular/platform-browser';

// The providers both entry points share. The app bootstrapped inline before SSR was added, and the
// server entry needs the same list, so it lives here and main.ts reads it too.
export const appConfig: ApplicationConfig = {
  providers: [provideClientHydration()],
};
