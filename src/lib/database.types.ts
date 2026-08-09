export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      areas: {
        Row: {
          capacity: number | null
          created_at: string
          description: string | null
          id: string
          name: string
          updated_at: string
          venue_id: string
        }
        Insert: {
          capacity?: number | null
          created_at?: string
          description?: string | null
          id?: string
          name: string
          updated_at?: string
          venue_id: string
        }
        Update: {
          capacity?: number | null
          created_at?: string
          description?: string | null
          id?: string
          name?: string
          updated_at?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "areas_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      email_sends: {
        Row: {
          created_at: string
          error_message: string | null
          event_count: number
          id: string
          idempotency_key: string | null
          sent_at: string
          status: string
          subscriber_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          event_count?: number
          id?: string
          idempotency_key?: string | null
          sent_at?: string
          status?: string
          subscriber_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          event_count?: number
          id?: string
          idempotency_key?: string | null
          sent_at?: string
          status?: string
          subscriber_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "email_sends_subscriber_id_fkey"
            columns: ["subscriber_id"]
            isOneToOne: false
            referencedRelation: "subscribers"
            referencedColumns: ["id"]
          },
        ]
      }
      embed_requests: {
        Row: {
          config: Json
          created_at: string
          email: string
          embed_path: string | null
          id: string
          name: string
          note: string | null
          notified_at: string | null
          organization: string
          status: string
          website: string | null
        }
        Insert: {
          config: Json
          created_at?: string
          email: string
          embed_path?: string | null
          id?: string
          name: string
          note?: string | null
          notified_at?: string | null
          organization: string
          status?: string
          website?: string | null
        }
        Update: {
          config?: Json
          created_at?: string
          email?: string
          embed_path?: string | null
          id?: string
          name?: string
          note?: string | null
          notified_at?: string | null
          organization?: string
          status?: string
          website?: string | null
        }
        Relationships: []
      }
      event_aliases: {
        Row: {
          canonical_event_id: string | null
          created_at: string
          duplicate_source: string
          duplicate_source_id: string
          reason: string | null
        }
        Insert: {
          canonical_event_id?: string | null
          created_at?: string
          duplicate_source: string
          duplicate_source_id: string
          reason?: string | null
        }
        Update: {
          canonical_event_id?: string | null
          created_at?: string
          duplicate_source?: string
          duplicate_source_id?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_aliases_canonical_event_id_fkey"
            columns: ["canonical_event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_areas: {
        Row: {
          area_id: string
          event_id: string
        }
        Insert: {
          area_id: string
          event_id: string
        }
        Update: {
          area_id?: string
          event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_areas_area_id_fkey"
            columns: ["area_id"]
            isOneToOne: false
            referencedRelation: "areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_areas_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_categories: {
        Row: {
          category: string
          event_id: string
        }
        Insert: {
          category: string
          event_id: string
        }
        Update: {
          category?: string
          event_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_categories_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_organizations: {
        Row: {
          event_id: string
          organization_id: string
        }
        Insert: {
          event_id: string
          organization_id: string
        }
        Update: {
          event_id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_organizations_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_organizations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      event_venues: {
        Row: {
          event_id: string
          venue_id: string
        }
        Insert: {
          event_id: string
          venue_id: string
        }
        Update: {
          event_id?: string
          venue_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "event_venues_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_venues_venue_id_fkey"
            columns: ["venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          age_restriction: string
          banner_eligible: boolean | null
          category_slugs: string[]
          created_at: string
          description: string | null
          description_normalized: string | null
          end_at: string | null
          event_attendance_mode: string
          event_status: string
          featured: boolean
          id: string
          image_file_size: number | null
          image_height: number | null
          image_url: string | null
          image_width: number | null
          is_accessible_for_free: boolean
          is_family: boolean
          is_fundraiser: boolean
          manual_overrides: Json
          needs_review: boolean
          price_max: number | null
          price_min: number | null
          slug: string | null
          source: string
          source_id: string | null
          source_url: string | null
          start_at: string
          status: string
          tags: string[]
          ticket_url: string | null
          title: string
          title_normalized: string | null
          updated_at: string
        }
        Insert: {
          age_restriction?: string
          banner_eligible?: boolean | null
          category_slugs?: string[]
          created_at?: string
          description?: string | null
          description_normalized?: string | null
          end_at?: string | null
          event_attendance_mode?: string
          event_status?: string
          featured?: boolean
          id?: string
          image_file_size?: number | null
          image_height?: number | null
          image_url?: string | null
          image_width?: number | null
          is_accessible_for_free?: boolean
          is_family?: boolean
          is_fundraiser?: boolean
          manual_overrides?: Json
          needs_review?: boolean
          price_max?: number | null
          price_min?: number | null
          slug?: string | null
          source?: string
          source_id?: string | null
          source_url?: string | null
          start_at: string
          status?: string
          tags?: string[]
          ticket_url?: string | null
          title: string
          title_normalized?: string | null
          updated_at?: string
        }
        Update: {
          age_restriction?: string
          banner_eligible?: boolean | null
          category_slugs?: string[]
          created_at?: string
          description?: string | null
          description_normalized?: string | null
          end_at?: string | null
          event_attendance_mode?: string
          event_status?: string
          featured?: boolean
          id?: string
          image_file_size?: number | null
          image_height?: number | null
          image_url?: string | null
          image_width?: number | null
          is_accessible_for_free?: boolean
          is_family?: boolean
          is_fundraiser?: boolean
          manual_overrides?: Json
          needs_review?: boolean
          price_max?: number | null
          price_min?: number | null
          slug?: string | null
          source?: string
          source_id?: string | null
          source_url?: string | null
          start_at?: string
          status?: string
          tags?: string[]
          ticket_url?: string | null
          title?: string
          title_normalized?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      feedback_posts: {
        Row: {
          author_name: string
          body: string
          category: string
          created_at: string
          id: number
          image_url: string | null
          is_private: boolean
          page_path: string | null
          resolved_at: string | null
          status: string
          votes: number
        }
        Insert: {
          author_name?: string
          body: string
          category: string
          created_at?: string
          id?: never
          image_url?: string | null
          is_private?: boolean
          page_path?: string | null
          resolved_at?: string | null
          status?: string
          votes?: number
        }
        Update: {
          author_name?: string
          body?: string
          category?: string
          created_at?: string
          id?: never
          image_url?: string | null
          is_private?: boolean
          page_path?: string | null
          resolved_at?: string | null
          status?: string
          votes?: number
        }
        Relationships: []
      }
      moderation_allowlist: {
        Row: {
          phrase: string
        }
        Insert: {
          phrase: string
        }
        Update: {
          phrase?: string
        }
        Relationships: []
      }
      moderation_terms: {
        Row: {
          kind: string
          severity: string
          term: string
        }
        Insert: {
          kind?: string
          severity: string
          term: string
        }
        Update: {
          kind?: string
          severity?: string
          term?: string
        }
        Relationships: []
      }
      organizations: {
        Row: {
          address: string | null
          city: string
          contact_email: string | null
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          manual_overrides: Json
          name: string
          photos: string[]
          slug: string | null
          state: string
          status: string
          updated_at: string
          website: string | null
          zip: string | null
        }
        Insert: {
          address?: string | null
          city?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          manual_overrides?: Json
          name: string
          photos?: string[]
          slug?: string | null
          state?: string
          status?: string
          updated_at?: string
          website?: string | null
          zip?: string | null
        }
        Update: {
          address?: string | null
          city?: string
          contact_email?: string | null
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          manual_overrides?: Json
          name?: string
          photos?: string[]
          slug?: string | null
          state?: string
          status?: string
          updated_at?: string
          website?: string | null
          zip?: string | null
        }
        Relationships: []
      }
      scraper_runs: {
        Row: {
          duration_ms: number | null
          error_message: string | null
          events_found: number
          events_inserted: number
          events_skipped: number
          events_updated: number
          id: number
          ran_at: string
          scraper_name: string
          status: string
        }
        Insert: {
          duration_ms?: number | null
          error_message?: string | null
          events_found?: number
          events_inserted?: number
          events_skipped?: number
          events_updated?: number
          id?: number
          ran_at?: string
          scraper_name: string
          status: string
        }
        Update: {
          duration_ms?: number | null
          error_message?: string | null
          events_found?: number
          events_inserted?: number
          events_skipped?: number
          events_updated?: number
          id?: number
          ran_at?: string
          scraper_name?: string
          status?: string
        }
        Relationships: []
      }
      slack_notifications: {
        Row: {
          channel_key: string
          completed_at: string | null
          created_at: string
          dedupe_key: string
          error: string | null
          id: number
          kind: string
          slack_ts: string | null
          status: string
          thread_ts: string | null
        }
        Insert: {
          channel_key: string
          completed_at?: string | null
          created_at?: string
          dedupe_key: string
          error?: string | null
          id?: number
          kind: string
          slack_ts?: string | null
          status?: string
          thread_ts?: string | null
        }
        Update: {
          channel_key?: string
          completed_at?: string | null
          created_at?: string
          dedupe_key?: string
          error?: string | null
          id?: number
          kind?: string
          slack_ts?: string | null
          status?: string
          thread_ts?: string | null
        }
        Relationships: []
      }
      subscribers: {
        Row: {
          auth_user_id: string | null
          confirmed: boolean
          created_at: string
          email: string
          frequency: string
          id: string
          lookahead_days: number
          preferences: Json
          send_day: number | null
          token: string
          unsubscribed_at: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          confirmed?: boolean
          created_at?: string
          email: string
          frequency?: string
          id?: string
          lookahead_days?: number
          preferences?: Json
          send_day?: number | null
          token?: string
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          confirmed?: boolean
          created_at?: string
          email?: string
          frequency?: string
          id?: string
          lookahead_days?: number
          preferences?: Json
          send_day?: number | null
          token?: string
          unsubscribed_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      venue_aliases: {
        Row: {
          alias_name: string | null
          alias_venue_id: string
          canonical_venue_id: string
          created_at: string
          reason: string | null
        }
        Insert: {
          alias_name?: string | null
          alias_venue_id: string
          canonical_venue_id: string
          created_at?: string
          reason?: string | null
        }
        Update: {
          alias_name?: string | null
          alias_venue_id?: string
          canonical_venue_id?: string
          created_at?: string
          reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venue_aliases_alias_venue_id_fkey"
            columns: ["alias_venue_id"]
            isOneToOne: true
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "venue_aliases_canonical_venue_id_fkey"
            columns: ["canonical_venue_id"]
            isOneToOne: false
            referencedRelation: "venues"
            referencedColumns: ["id"]
          },
        ]
      }
      venues: {
        Row: {
          address: string | null
          city: string
          created_at: string
          description: string | null
          id: string
          image_url: string | null
          lat: number | null
          listed: boolean
          lng: number | null
          manual_overrides: Json
          name: string
          neighborhood_slug: string | null
          organization_id: string | null
          parking_notes: string | null
          parking_type: string | null
          slug: string | null
          state: string
          status: string
          tags: string[]
          updated_at: string
          website: string | null
          zip: string | null
        }
        Insert: {
          address?: string | null
          city?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          lat?: number | null
          listed?: boolean
          lng?: number | null
          manual_overrides?: Json
          name: string
          neighborhood_slug?: string | null
          organization_id?: string | null
          parking_notes?: string | null
          parking_type?: string | null
          slug?: string | null
          state?: string
          status?: string
          tags?: string[]
          updated_at?: string
          website?: string | null
          zip?: string | null
        }
        Update: {
          address?: string | null
          city?: string
          created_at?: string
          description?: string | null
          id?: string
          image_url?: string | null
          lat?: number | null
          listed?: boolean
          lng?: number | null
          manual_overrides?: Json
          name?: string
          neighborhood_slug?: string | null
          organization_id?: string | null
          parking_notes?: string | null
          parking_type?: string | null
          slug?: string | null
          state?: string
          status?: string
          tags?: string[]
          updated_at?: string
          website?: string | null
          zip?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "venues_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      scraper_health: {
        Row: {
          alert: string | null
          avg_events_last5: number | null
          consecutive_zeros: number | null
          hours_since_run: number | null
          is_error: boolean | null
          is_stale: boolean | null
          is_zero_streak: boolean | null
          last_error: string | null
          last_events_found: number | null
          last_ran_at: string | null
          last_status: string | null
          scraper_name: string | null
          total_runs: number | null
        }
        Relationships: []
      }
      v_dupe_candidates: {
        Row: {
          canonical_id: string | null
          duplicate_id: string | null
          rule: string | null
          source_a: string | null
          source_b: string | null
          start_at: string | null
          start_at_b: string | null
          title_a: string | null
          title_b: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      event_is_pending_review: {
        Args: { p_event_id: string }
        Returns: boolean
      }
      moderation_request_role: { Args: never; Returns: string }
      moderation_severity: { Args: { input: string }; Returns: string }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      source_priority: { Args: { src: string }; Returns: number }
      sync_event_category_slugs: {
        Args: { p_event_id: string }
        Returns: undefined
      }
      turnout_slugify: { Args: { input: string }; Returns: string }
      turnout_unique_slug: {
        Args: { p_base: string; p_id: string; p_table: string }
        Returns: string
      }
      unaccent: { Args: { "": string }; Returns: string }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
