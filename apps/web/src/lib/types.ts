export type MediaKind = 'image' | 'video' | 'gif';

export type PostSource = 'demo' | 'syndication' | 'manual' | 'library';

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
  /** Mirrored stany z X: polubienie / zakładka. */
  xLiked?: boolean;
  xBookmarked?: boolean;
  /** Jak post trafił do offline. */
  via?: 'manual' | 'auto-scroll' | 'bookmarks-mirror' | 'fill' | 'import';
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
  /** 'ok' | 'blocked' | 'empty' | 'error' */
  lastStatus?: string;
  lastError?: string;
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

export interface Settings {
  sourceMode: 'auto' | 'demo' | 'proxy' | 'direct';
  proxyUrl: string;
  /** Szablon URL-a dla zakładki „Na żywo”. {handle} = nazwa użytkownika. */
  liveFrameTemplate: string;
  /** Miękki limit miejsca w MB (0 = bez limitu). */
  storageCapMb: number;
  autoPrune: boolean;
  pruneKeepPosts: number;
  autoSyncOnOpen: boolean;
  /** Pobieraj wideo (potrafią ważyć 5-20 MB). */
  downloadVideo: boolean;
  /** Ogranicz pobieranie przy oszczędzaniu danych w systemie. */
  respectSaveData: boolean;
  /** Pełnoekranowy odtwarzacz w stylu pionowej szpulki. */
  reelMode: boolean;
  fontSize: number;

  // ——— auto-offline (to jest teraz rdzeń apki) ———
  /** Zapisuj do offline każdy post napotkany w podglądzie na żywo. */
  autoCapture: boolean;
  /** Do ilu postów dokarmiać offline (50 / 100 / 200 / 500). */
  autoTarget: number;
  /** Samo przewijanie w podglądzie, aż zbierze się partia postów. */
  autoScroll: boolean;
  /** Rozmiar jednej porcji przy auto-przewijaniu (ile ekranów na raz). */
  scrollBatch: number;
  /** Traktuj zakładki X (bookmarks) jako źródło postów do offline. */
  mirrorBookmarks: boolean;
  /** Odwrotnie: to, co zapiszesz w X-Offline, dodaj też do zakładek X (gdy będzie łącze). */
  mirrorToBookmarks: boolean;
  /** Wysyłaj zaległe polubienia/zakładki, gdy tylko apka złapie łącze. */
  replayActions: boolean;
  /** Pobieraj media tylko na Wi-Fi (systemowe saveData też jest szanowane). */
  mediaOnWifiOnly: boolean;
  /** Miękki limit: gdy offline ma >= autoTarget postów, przestań dokarmiać. */
  trimOverTarget: boolean;
  /** Lista kont, z których czytamy w przeglądarce (enter / przecinek). W APK zbieramy to, co widzisz. */
  followList: string;
}

export const DEFAULT_SETTINGS: Settings = {
  sourceMode: 'auto',
  proxyUrl: '',
  liveFrameTemplate: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/{handle}',
  storageCapMb: 256,
  autoPrune: true,
  pruneKeepPosts: 300,
  autoSyncOnOpen: false,
  downloadVideo: true,
  respectSaveData: true,
  reelMode: true,
  fontSize: 15,
  autoCapture: true,
  autoTarget: 200,
  autoScroll: true,
  scrollBatch: 8,
  mirrorBookmarks: true,
  mirrorToBookmarks: false,
  replayActions: true,
  mediaOnWifiOnly: false,
  trimOverTarget: false,
  followList: 'kasia_koduje, silesia_dev, orbita_pl, foto_wegierek, low_bitrate, x_offline',
};
