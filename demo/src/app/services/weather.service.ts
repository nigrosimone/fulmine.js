import { inject, Service } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import type { WeatherData, GeocodingResult } from '../types/weather.types';

@Service()
export class WeatherService {
  private readonly baseUrl = 'https://api.open-meteo.com/v1';
  private readonly geocodingUrl = 'https://geocoding-api.open-meteo.com/v1';
  // HttpClient rather than fetch, and the difference is not style: hydration's transfer cache only
  // records what goes through here, so this is what stops the browser asking open-meteo for what
  // the server already asked it during the render.
  private readonly http = inject(HttpClient);

  private fetchJson<T>(url: string): Observable<T> {
    return this.http.get<T>(url, { withCredentials: false });
  }

  private geocodeLocation(cityName: string): Observable<GeocodingResult> {
    const params = new URLSearchParams({
      name: cityName,
      count: '1',
      language: 'en',
      format: 'json',
    });

    return this.fetchJson<{ results: GeocodingResult[] }>(
      `${this.geocodingUrl}/search?${params}`,
    ).pipe(
      map((response) => {
        if (!response.results || response.results.length === 0) {
          throw new Error('Location not found');
        }
        return response.results[0];
      }),
      catchError((error) => {
        console.error('Geocoding error:', error);
        return throwError(
          () => new Error('Unable to find location. Please check the city name and try again.'),
        );
      }),
    );
  }

  private getWeatherData(latitude: number, longitude: number): Observable<WeatherData> {
    const params = new URLSearchParams({
      latitude: latitude.toString(),
      longitude: longitude.toString(),
      daily:
        'temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,rain_sum,uv_index_max,precipitation_probability_max',
      current:
        'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,snowfall,showers,rain,precipitation,weather_code,cloud_cover,pressure_msl,surface_pressure,wind_direction_10m,wind_gusts_10m,wind_speed_10m',
      timezone: 'GMT',
    });

    return this.fetchJson<WeatherData>(`${this.baseUrl}/forecast?${params}`).pipe(
      catchError((error) => {
        console.error('Weather API error:', error);
        return throwError(() => new Error('Unable to fetch weather data. Please try again later.'));
      }),
    );
  }

  getWeatherByCity(cityName: string): Observable<WeatherData> {
    return this.geocodeLocation(cityName).pipe(
      switchMap((location) =>
        this.getWeatherData(location.latitude, location.longitude).pipe(
          map((weather) => ({
            ...weather,
            locationName: location.name,
            country: location.country,
          })),
        ),
      ),
    );
  }
}
