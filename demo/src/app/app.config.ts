import { ApplicationConfig } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideClientHydration } from '@angular/platform-browser';

// The providers both entry points share. The app bootstrapped inline before SSR was added, and the
// server entry needs the same list, so it lives here and main.ts reads it too.
//
// provideHttpClient is what makes hydration worth having: the transfer cache built into
// provideClientHydration only sees HttpClient, so a service calling fetch() directly renders on the
// server and then fetches everything again in the browser. That was two round trips to open-meteo
// after the HTML had arrived, and the content vanishing into its loading state and coming back:
// 0.312 of layout shift, measured, which is most of a Lighthouse performance score.
export const appConfig: ApplicationConfig = {
  providers: [provideClientHydration(), provideHttpClient()],
};
