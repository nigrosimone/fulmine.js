import { Component, inject } from '@angular/core';
import { WeatherStateService } from './services/weather-state.service';
import { SearchFormComponent } from './components/search-form.component';
import { LoadingStateComponent } from './components/loading-state.component';
import { ErrorStateComponent } from './components/error-state.component';
import { WeatherContentComponent } from './components/weather-content.component';
import { ServerPanelComponent } from './components/server-panel.component';
import { ChatComponent } from './components/chat.component';

@Component({
  selector: 'app-root',
  imports: [
    SearchFormComponent,
    LoadingStateComponent,
    ErrorStateComponent,
    WeatherContentComponent,
    ServerPanelComponent,
    ChatComponent,
  ],
  template: `
    <header class="header">
      <div class="container">
        <h1 class="header__title">Weather Front</h1>
        <p class="header__subtitle">
          Angular 22, server-side rendered, served by
          <a href="https://github.com/nigrosimone/fulmine.js" target="_blank" rel="noopener"
            >Fulmine</a
          >
        </p>
      </div>
    </header>

    <main class="main">
      <div class="container">
        <app-search-form
          [isLoading]="weatherState.weather.isLoading()"
          (search)="weatherState.loadWeather($event)"
        ></app-search-form>

        <div class="weather-container" data-testid="weather-container">
          <app-loading-state [isVisible]="weatherState.weather.isLoading()"></app-loading-state>

          <app-error-state
            [isVisible]="!!weatherState.weather.error() && !weatherState.weather.isLoading()"
            [message]="$any(weatherState.weather.error())?.message"
          ></app-error-state>

          @if (
            weatherState.weather.hasValue() &&
            !weatherState.weather.isLoading() &&
            !weatherState.weather.error()
          ) {
            <app-weather-content
              [weatherData]="weatherState.weather.value()!"
            ></app-weather-content>
          }
        </div>

        <app-server-panel></app-server-panel>
        <app-chat></app-chat>
      </div>
    </main>

    <footer class="footer">
      <div class="container">
        <p class="footer__text">
          Weather app by
          <a href="https://github.com/Lissy93" class="footer__link" target="_blank" rel="noopener">
            Alicia Sykes
          </a>
          • MIT License • server by
          <a
            href="https://github.com/nigrosimone/fulmine.js"
            class="footer__link"
            target="_blank"
            rel="noopener"
          >
            Fulmine
          </a>
        </p>
      </div>
    </footer>
  `,
  styles: `
    .header__subtitle {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
      margin: 0;
    }
    .header__subtitle a {
      color: inherit;
    }
  `,
})
export class AppComponent {
  protected readonly weatherState = inject(WeatherStateService);
}
