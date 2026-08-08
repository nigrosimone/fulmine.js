import { Component, input } from '@angular/core';

@Component({
  selector: 'app-loading-state',
  template: `
    <div class="loading" data-testid="loading" [hidden]="!isVisible()">
      <div class="loading__spinner"></div>
      <p>Loading weather data...</p>
    </div>
  `,
})
export class LoadingStateComponent {
  readonly isVisible = input(false);
}
