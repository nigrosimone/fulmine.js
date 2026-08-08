import { Component, input, output, signal, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

@Component({
  selector: 'app-search-form',
  template: `
    <section class="search-section">
      <form class="search-form" data-testid="search-form" (submit)="onSubmit($event)">
        <div class="search-form__group">
          <label for="location-input" class="sr-only">Enter city name</label>
          <input
            #locationInput
            type="text"
            id="location-input"
            class="search-input"
            placeholder="Enter city name..."
            data-testid="search-input"
            autocomplete="off"
            [value]="city()"
            (input)="city.set(locationInput.value)"
          />
          <button
            type="submit"
            class="search-button"
            data-testid="search-button"
            [disabled]="isLoading()"
          >
            <span class="search-button__text">
              {{ isLoading() ? 'Loading...' : 'Get Weather' }}
            </span>
            <span class="search-button__icon">🌦️</span>
          </button>
        </div>
      </form>
    </section>
  `,
})
export class SearchFormComponent {
  readonly isLoading = input(false);
  readonly search = output<string>();
  readonly city = signal(this.getSavedLocation() ?? 'London');

  onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const city = this.city().trim();

    if (!city) {
      return;
    }

    this.city.set(city);
    this.search.emit(city);
  }

  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

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
