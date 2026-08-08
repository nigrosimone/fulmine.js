import { Service, signal, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { rxResource } from '@angular/core/rxjs-interop';
import { WeatherService } from './weather.service';
import type { WeatherData } from '../types/weather.types';

@Service()
export class WeatherStateService {
  private readonly weatherService = inject(WeatherService);

  /** The city signal drives the rxResource reactively. */
  readonly city = signal<string>(this.getInitialCity());

  readonly weather = rxResource<WeatherData, { city: string }>({
    params: () => ({ city: this.city() }),
    stream: ({ params }) => this.weatherService.getWeatherByCity(params.city),
  });

  loadWeather(city: string): void {
    this.city.set(city);
    this.saveLocation(city);
  }

  private getInitialCity(): string {
    return this.getSavedLocation() ?? 'London';
  }

  // localStorage belongs to the browser; on the server these two simply do nothing
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  private saveLocation(city: string): void {
    if (!this.isBrowser) return;
    try {
      localStorage.setItem('weather-app-location', city);
    } catch (error) {
      console.warn('Could not save location to localStorage:', error);
    }
  }

  private getSavedLocation(): string | null {
    if (!this.isBrowser) return null;
    try {
      return localStorage.getItem('weather-app-location');
    } catch (error) {
      console.warn('Could not load saved location:', error);
      return null;
    }
  }
}
