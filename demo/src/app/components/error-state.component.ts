import { Component, input } from '@angular/core';

@Component({
  selector: 'app-error-state',
  template: `
    <div class="error" data-testid="error" [hidden]="!isVisible()">
      <h2 class="error__title">Unable to load weather data</h2>
      <p class="error__message">
        {{ message() || 'Please check the city name and try again.' }}
      </p>
    </div>
  `,
})
export class ErrorStateComponent {
  readonly isVisible = input(false);
  readonly message = input<string | null>(null);
}
