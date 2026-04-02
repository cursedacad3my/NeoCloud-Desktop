import { create } from 'zustand';

export type FullscreenPanelMode = 'none' | 'artwork' | 'lyrics';
export type TransitionDirection = 'none' | 'toLyrics' | 'toArtwork';
export type FullscreenOpenAnimation = 'default' | 'fromMiniPlayer';

interface FullscreenPanelState {
  mode: FullscreenPanelMode;
  transitionDirection: TransitionDirection;
  openAnimation: FullscreenOpenAnimation;
  setMode: (mode: FullscreenPanelMode) => void;
  setTransitionDirection: (dir: TransitionDirection) => void;
  setOpenAnimation: (animation: FullscreenOpenAnimation) => void;
  close: () => void;
}

interface LyricsUIState {
  open: boolean;
  toggle: () => void;
  openFromMiniPlayer: () => void;
  openPanel: () => void;
  close: () => void;
}

export interface ArtworkUIState {
  open: boolean;
  setOpen: (open: boolean) => void;
  openFromMiniPlayer: () => void;
}

export const useFullscreenPanelStore = create<FullscreenPanelState>()((set) => ({
  mode: 'none',
  transitionDirection: 'none',
  openAnimation: 'default',
  setMode: (mode) => set({ mode }),
  setTransitionDirection: (dir) => set({ transitionDirection: dir }),
  setOpenAnimation: (animation) => set({ openAnimation: animation }),
  close: () => set({ mode: 'none', transitionDirection: 'none', openAnimation: 'default' }),
}));

export const useLyricsStore = create<LyricsUIState>()((set) => ({
  open: false,
  toggle: () =>
    set((s) => {
      const nextOpen = !s.open;
      if (nextOpen) {
        useArtworkStore.setState({ open: false });
        useFullscreenPanelStore.getState().setOpenAnimation('default');
        useFullscreenPanelStore.getState().setTransitionDirection('toLyrics');
        useFullscreenPanelStore.getState().setMode('lyrics');
        setTimeout(() => useFullscreenPanelStore.getState().setTransitionDirection('none'), 500);
      } else {
        useFullscreenPanelStore.getState().close();
      }
      return { open: nextOpen };
    }),
  openFromMiniPlayer: () => {
    useArtworkStore.setState({ open: false });
    useFullscreenPanelStore.getState().setOpenAnimation('fromMiniPlayer');
    useFullscreenPanelStore.getState().setTransitionDirection('none');
    useFullscreenPanelStore.getState().setMode('lyrics');
    set({ open: true });
  },
  openPanel: () => {
    useArtworkStore.setState({ open: false });
    useFullscreenPanelStore.getState().setOpenAnimation('default');
    useFullscreenPanelStore.getState().setTransitionDirection('toLyrics');
    useFullscreenPanelStore.getState().setMode('lyrics');
    setTimeout(() => useFullscreenPanelStore.getState().setTransitionDirection('none'), 500);
    set({ open: true });
  },
  close: () => {
    useFullscreenPanelStore.getState().close();
    set({ open: false });
  },
}));

export const useArtworkStore = create<ArtworkUIState>()((set) => ({
  open: false,
  openFromMiniPlayer: () => {
    useLyricsStore.setState({ open: false });
    useFullscreenPanelStore.getState().setOpenAnimation('fromMiniPlayer');
    useFullscreenPanelStore.getState().setTransitionDirection('none');
    useFullscreenPanelStore.getState().setMode('artwork');
    set({ open: true });
  },
  setOpen: (open) => {
    if (open) {
      useLyricsStore.setState({ open: false });
      useFullscreenPanelStore.getState().setOpenAnimation('default');
      useFullscreenPanelStore.getState().setTransitionDirection('toArtwork');
      useFullscreenPanelStore.getState().setMode('artwork');
      setTimeout(() => useFullscreenPanelStore.getState().setTransitionDirection('none'), 500);
    } else if (useFullscreenPanelStore.getState().mode === 'artwork') {
      useFullscreenPanelStore.getState().close();
    }

    set({ open });
  },
}));
