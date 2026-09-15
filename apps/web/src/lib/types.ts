export type MediaKind = 'image' | 'video' | 'gif';

/**
 * Skąd pochodzi treść posta. Zawsze z X — apka nie generuje żadnych
 * sztucznych treści ani nie pobiera nic z żadnych API/proxy.
 */
export type PostSource = 'syndication' | 'manual' | 'library';

/** Jak post trafił do bazy (kolejność wędrówki po apce). */
export type PostOrigin = 'live' | 'mirror' | 'import' | 'profile' | 'links';

export interface MediaItem {
  kind: MediaKind;
  /** URL bezwzględny do oryginalnego zasobu. */
  url: string;
  /** Opcjonalny plakat dla wideo/GIF. */
  poster?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Czy binarka leży już w IndexedDB. */
  cached?: boolean;
  bytes?: number;
  alt?: string;
}

export interface PostLinkCard {
  domain: string;
  title: string;
  brief?: string;
  url: string;
  image?: string;
}

export interface PostStats {
  replies: number;
  reposts: number;
  likes: number;
  views?: number;
}

export interface PostRecord {
  /** `${source}:${nativeId}` — klucz główny. */
  id: string;
  nativeId: string;
  source: PostSource;
  url?: string;
  authorHandle: string;
  authorName: string;
  authorAvatar?: string;
  text: string;
  lang?: string;
  createdAt: number;
  /** Ustawione, gdy post jest zapisany do czytania offline. */
  savedAt?: number | null;
  /** Kiedy przeczytany w czytniku (null = nieprzeczytany). */
  readAt?: number | null;
  stats: PostStats;
  media: MediaItem[];
  card?: PostLinkCard;
  /** Post jest odpowiedzią / cytatem — używane tylko do filtrów. */
  isReply?: boolean;
  retweetedBy?: string;
  /** Suma bajtów pobranych mediów. */
  sizeBytes: number;
  /** Tagi z #hashtagów i @wzmianek. */
  tags?: string[];
  /** Kontekst pobrania (np. z profilu kogo). */
  fetchedFrom?: string;
  /** Którym kanałem post wszedł do bazy. */
  origin?: PostOrigin;
  /** Mirrored stany z X: polubienie / zakładka. */
  xLiked?: boolean;
  xBookmarked?: boolean;
  /** Jak post trafił do offline. */
  via?: 'manual' | 'auto-scroll' | 'bookmarks-mirror' | 'fill' | 'import';
  /** Ostatni błąd pobierania mediów (do pokazania w UI). */
  mediaError?: string;
  /** Kiedy ostatnio próbowaliśmy odtworzyć akcję w X. */
  actionError?: string;
}

export interface AccountRow {
  handle: string;
  name?: string;
  avatar?: string;
  description?: string;
  followers?: number;
  lastSyncAt?: number | null;
  autoSync?: boolean;
  savedCount?: number;
  /** Ile postów pobierać przy synchronizacji. */
  fetchCount?: number;
  /** 'ok' | 'blocked' | 'empty' | 'error' | 'imported' */
  lastStatus?: string;
  lastError?: string;
  /** Skąd konto trafiło na listę: ręcznie czy z importu biblioteki. */
  origin?: 'manual' | 'import';
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobRow {
  id?: number;
  type: 'profile' | 'links' | 'library' | 'prune';
  label: string;
  status: JobStatus;
  total: number;
  done: number;
  bytes: number;
  errors: string[];
  createdAt: number;
  finishedAt?: number | null;
  lastError?: string;
}

export type ActionKind = 'like' | 'unlike' | 'bookmark' | 'unbookmark';
export type ActionStatus = 'pending' | 'sending' | 'sent' | 'error';

export interface ActionRow {
  id?: number;
  kind: ActionKind;
  /** ID posta w X (nie nasz klucz!) — żeby dało się odtworzyć bez rekordu w bazie. */
  tweetId: string;
  tweetUrl?: string;
  postId: string;
  authorHandle?: string;
  snippet?: string;
  status: ActionStatus;
  attempts: number;
  createdAt: number;
  sentAt?: number | null;
  error?: string;
  /** Skąd się wzięło: ręcznie w czytniku czy z lustrzanki X. */
  origin?: 'offline-reader' | 'mirror' | 'manual';
}

export interface BlobRow {
  key: string;
  postId: string;
  url: string;
  mime: string;
  bytes: number;
  createdAt: number;
  blob: Blob;
}

/**
 * Ustawienia — celowo mały zestaw. Apka ma robić jedną rzecz dobrze:
 * zbierać posty z podglądu X (WebView) i dawać je do czytania offline.
 */
export interface Settings {
  /** Miękki limit miejsca w MB (0 = bez limitu). */
  storageCapMb: number;
  autoPrune: boolean;
  /** Pobieraj wideo (potrafią ważyć 5-20 MB). */
  downloadVideo: boolean;
  /** Ogranicz pobieranie przy oszczędzaniu danych w systemie. */
  respectSaveData: boolean;
  /** Pełnoekranowy czytnik w stylu pionowej szpulki. */
  reelMode: boolean;
  fontSize: number;
  /** Prośba o trwałe miejsce w IndexedDB (system nie wyrzuci zapisanych postów). */
  persistStorage: boolean;
  /** Otwarcie posta w czytniku oznacza go jako przeczytany. */
  markReadOnOpen: boolean;

  // ——— zbieranie z podglądu X ———
  /** Zapisuj do offline każdy post napotkany w podglądzie. */
  autoCapture: boolean;
  /** Do ilu postów zbierać (50 / 100 / 200 / 500). */
  autoTarget: number;
  /** Samo przewijanie w podglądzie, aż zbierze się partia postów. */
  autoScroll: boolean;
  /** Traktuj zakładki X (bookmarks) jako źródło postów do offline. */
  mirrorBookmarks: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  storageCapMb: 256,
  autoPrune: true,
  downloadVideo: true,
  respectSaveData: true,
  reelMode: true,
  fontSize: 15,
  persistStorage: true,
  markReadOnOpen: true,
  autoCapture: true,
  autoTarget: 200,
  autoScroll: true,
  mirrorBookmarks: true,
};
