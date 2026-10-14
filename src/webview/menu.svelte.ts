export interface MenuItem {
  label: string;
  hint?: string;
  icon?: string;
  disabled?: boolean;
  run?: () => void;
  submenu?: MenuEntry[];
}

export type MenuEntry = MenuItem | 'separator';

class MenuState {
  entries = $state.raw<MenuEntry[]>([]);
  x = $state(0);
  y = $state(0);
  open = $state(false);

  show(event: MouseEvent, entries: MenuEntry[]): void {
    event.preventDefault();
    event.stopPropagation();
    this.entries = entries;
    this.x = event.clientX;
    this.y = event.clientY;
    this.open = true;
  }

  close(): void {
    this.open = false;
  }
}

export const menu = new MenuState();
