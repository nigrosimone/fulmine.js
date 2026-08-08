import { Component, DestroyRef, inject, signal } from '@angular/core';

interface Line {
  text: string;
  meta: boolean;
}

/**
 * The websocket half. One room per path parameter, which is `app.ws()` on the server doing the two
 * things it promises: the upgrade decides whether the socket opens, and the request stays reachable
 * as `ws.req` afterwards. Type a room name with a capital letter and the upgrade refuses it.
 */
@Component({
  selector: 'app-chat',
  template: `
    <section class="panel">
      <h2 class="section-title">Websockets, on the same app</h2>
      <p class="panel__muted">
        <code>app.ws('/ws/:room')</code>, publishing to everyone subscribed to the room. Open this
        page in a second tab to see both sides.
      </p>

      <div class="chat__bar">
        <input
          #roomInput
          class="search-input chat__room"
          [value]="room()"
          (input)="room.set(roomInput.value)"
          placeholder="room name"
          aria-label="Room name"
        />
        <button type="button" class="search-button" (click)="connect()">
          {{ open() ? 'Reconnect' : 'Connect' }}
        </button>
        <span class="panel__muted">{{ people() }} connected</span>
      </div>

      <ul class="chat__log">
        @for (line of lines(); track $index) {
          <li [class.chat__meta]="line.meta">{{ line.text }}</li>
        } @empty {
          <li class="chat__meta">not connected</li>
        }
      </ul>

      <div class="chat__bar">
        <input
          #draftInput
          class="search-input"
          [disabled]="!open()"
          placeholder="say something"
          aria-label="Message"
          (keyup.enter)="send(draftInput)"
        />
        <button type="button" class="search-button" [disabled]="!open()" (click)="send(draftInput)">
          Send
        </button>
      </div>
    </section>
  `,
  styles: `
    .panel {
      background: var(--color-surface);
      border: 1px solid var(--color-border);
      border-radius: var(--radius-lg);
      padding: var(--space-lg);
      margin-bottom: var(--space-lg);
    }
    .panel__muted {
      color: var(--color-text-muted);
      font-size: var(--font-size-sm);
      margin: 0 0 var(--space-md);
    }
    .chat__bar {
      display: flex;
      gap: var(--space-sm);
      align-items: center;
      flex-wrap: wrap;
    }
    .chat__room {
      max-width: 12rem;
    }
    .chat__log {
      list-style: none;
      margin: var(--space-md) 0;
      padding: var(--space-md);
      background: var(--color-background);
      border-radius: var(--radius-md);
      height: 9rem;
      overflow-y: auto;
      font-size: var(--font-size-sm);
    }
    .chat__meta {
      color: var(--color-text-muted);
      font-style: italic;
    }
  `,
})
export class ChatComponent {
  protected readonly room = signal('lobby');
  protected readonly lines = signal<Line[]>([]);
  protected readonly people = signal(0);
  protected readonly open = signal(false);

  private socket: WebSocket | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.socket?.close());
  }

  protected connect(): void {
    this.socket?.close();
    const room = this.room().trim();
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${scheme}://${location.host}/ws/${encodeURIComponent(room)}`;
    this.append(`connecting to /ws/${room}`, true);

    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onopen = () => this.open.set(true);
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'joined') this.append(`joined ${data.room}`, true);
      else if (data.type === 'people') this.people.set(data.people);
      else if (data.type === 'message') this.append(data.text, false);
    };
    socket.onclose = () => {
      this.open.set(false);
      // the upgrade hook refuses a room name it does not like, and the socket never opens
      this.append('disconnected. A room is lowercase letters, digits or dashes.', true);
    };
  }

  protected send(input: HTMLInputElement): void {
    const text = input.value.trim();
    if (!text || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(text);
    input.value = '';
  }

  private append(text: string, meta: boolean): void {
    this.lines.update((list) => [...list, { text, meta }].slice(-50));
  }
}
