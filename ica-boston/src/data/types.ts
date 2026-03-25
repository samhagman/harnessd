/* ==========================================================================
   Data Types — ICA Boston 2026
   Shared TypeScript interfaces for exhibition and event data.
   ========================================================================== */

export interface Exhibition {
  /** Unique identifier */
  id: string
  /** Exhibition title */
  title: string
  /** Artist or collective name */
  artist: string
  /** Start date (ISO 8601 string) */
  startDate: string
  /** End date (ISO 8601 string) */
  endDate: string
  /** Hero/featured image URL or path */
  image: string
  /** Short description for cards and previews */
  description: string
  /** Whether this is the currently featured exhibition */
  isFeatured?: boolean
  /** Exhibition category or medium */
  category?: string
}

export interface Event {
  /** Unique identifier */
  id: string
  /** Event title */
  title: string
  /** Event date and time (ISO 8601 string) */
  date: string
  /** Event category (e.g., 'Opening', 'Talk', 'Performance', 'Family', 'Workshop') */
  category: string
  /** Venue or location within the museum */
  venue: string
  /** Short description */
  description: string
  /** Event image URL or path */
  image?: string
  /** Whether the event is free with membership */
  membersFree?: boolean
  /** Ticket price in dollars (0 = free) */
  price?: number
}
