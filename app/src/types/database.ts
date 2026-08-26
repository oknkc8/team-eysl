export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activities: {
        Row: {
          activity_date: string
          capacity: number | null
          created_at: string
          created_by: string | null
          details: Json
          end_time: string | null
          id: string
          kind: string
          place: string | null
          start_time: string | null
          title: string
          updated_at: string
        }
        Insert: {
          activity_date: string
          capacity?: number | null
          created_at?: string
          created_by?: string | null
          details?: Json
          end_time?: string | null
          id?: string
          kind: string
          place?: string | null
          start_time?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          activity_date?: string
          capacity?: number | null
          created_at?: string
          created_by?: string | null
          details?: Json
          end_time?: string | null
          id?: string
          kind?: string
          place?: string | null
          start_time?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "activities_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activities_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      activity_applications: {
        Row: {
          activity_id: string
          application_type: string
          created_at: string
          details: Json
          id: string
          member_id: string
          offer_expires_at: string | null
          offer_status: string
          updated_at: string
          wait_order: number | null
        }
        Insert: {
          activity_id: string
          application_type: string
          created_at?: string
          details?: Json
          id?: string
          member_id: string
          offer_expires_at?: string | null
          offer_status?: string
          updated_at?: string
          wait_order?: number | null
        }
        Update: {
          activity_id?: string
          application_type?: string
          created_at?: string
          details?: Json
          id?: string
          member_id?: string
          offer_expires_at?: string | null
          offer_status?: string
          updated_at?: string
          wait_order?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_applications_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_applications_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "activity_applications_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      attendance: {
        Row: {
          activity_id: string
          id: string
          late_fee_amount: number | null
          late_fee_paid: boolean
          marked_at: string
          marked_by: string
          member_id: string
          status: string
          updated_at: string
        }
        Insert: {
          activity_id: string
          id?: string
          late_fee_amount?: number | null
          late_fee_paid?: boolean
          marked_at?: string
          marked_by: string
          member_id: string
          status: string
          updated_at?: string
        }
        Update: {
          activity_id?: string
          id?: string
          late_fee_amount?: number | null
          late_fee_paid?: boolean
          marked_at?: string
          marked_by?: string
          member_id?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "attendance_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_marked_by_fkey"
            columns: ["marked_by"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_marked_by_fkey"
            columns: ["marked_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "attendance_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      board_posts: {
        Row: {
          author_id: string
          body: string
          created_at: string
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          author_id: string
          body: string
          created_at?: string
          id?: string
          title: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          body?: string
          created_at?: string
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "board_posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "board_posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      media_files: {
        Row: {
          created_at: string
          file_name: string
          folder_id: string | null
          id: string
          mime_type: string
          storage_path: string
          uploader_id: string
        }
        Insert: {
          created_at?: string
          file_name: string
          folder_id?: string | null
          id?: string
          mime_type?: string
          storage_path: string
          uploader_id: string
        }
        Update: {
          created_at?: string
          file_name?: string
          folder_id?: string | null
          id?: string
          mime_type?: string
          storage_path?: string
          uploader_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_files_folder_id_fkey"
            columns: ["folder_id"]
            isOneToOne: false
            referencedRelation: "media_folders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_files_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_files_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      media_folders: {
        Row: {
          created_at: string
          created_by: string
          id: string
          name: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          name: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "media_folders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "media_folders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      members: {
        Row: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        Insert: {
          auth_user_id?: string | null
          avatar_path?: string | null
          birth_date_text?: string | null
          birth_year?: number | null
          created_at?: string
          gender?: string | null
          historical_attendance_count_legacy?: number
          historical_late_count_legacy?: number
          id?: string
          join_date_text?: string | null
          join_reason?: string | null
          lesson_level?: string | null
          location?: string | null
          nickname: string
          notes?: string | null
          real_name?: string | null
          role?: string
          short_name?: string | null
          signup_pass_expires_at?: string | null
          status?: string
          swim_experience?: string | null
          team_role?: string | null
          updated_at?: string
        }
        Update: {
          auth_user_id?: string | null
          avatar_path?: string | null
          birth_date_text?: string | null
          birth_year?: number | null
          created_at?: string
          gender?: string | null
          historical_attendance_count_legacy?: number
          historical_late_count_legacy?: number
          id?: string
          join_date_text?: string | null
          join_reason?: string | null
          lesson_level?: string | null
          location?: string | null
          nickname?: string
          notes?: string | null
          real_name?: string | null
          role?: string
          short_name?: string | null
          signup_pass_expires_at?: string | null
          status?: string
          swim_experience?: string | null
          team_role?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          attachment_path: string | null
          attachment_type: string | null
          body: string | null
          created_at: string
          id: string
          recipient_id: string | null
          room_type: string
          sender_id: string
        }
        Insert: {
          attachment_path?: string | null
          attachment_type?: string | null
          body?: string | null
          created_at?: string
          id?: string
          recipient_id?: string | null
          room_type: string
          sender_id: string
        }
        Update: {
          attachment_path?: string | null
          attachment_type?: string | null
          body?: string | null
          created_at?: string
          id?: string
          recipient_id?: string | null
          room_type?: string
          sender_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_recipient_id_fkey"
            columns: ["recipient_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_sender_id_fkey"
            columns: ["sender_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      notice_attachments: {
        Row: {
          created_at: string
          file_name: string
          id: string
          mime_type: string
          notice_id: string
          sort_order: number
          storage_path: string
        }
        Insert: {
          created_at?: string
          file_name: string
          id?: string
          mime_type?: string
          notice_id: string
          sort_order?: number
          storage_path: string
        }
        Update: {
          created_at?: string
          file_name?: string
          id?: string
          mime_type?: string
          notice_id?: string
          sort_order?: number
          storage_path?: string
        }
        Relationships: [
          {
            foreignKeyName: "notice_attachments_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
        ]
      }
      notice_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          member_id: string
          notice_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          member_id: string
          notice_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          member_id?: string
          notice_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notice_comments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notice_comments_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notice_comments_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
        ]
      }
      notices: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          title: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_object_deletions: {
        Row: {
          requested_at: string
          requested_by: string | null
          storage_path: string
        }
        Insert: {
          requested_at?: string
          requested_by?: string | null
          storage_path: string
        }
        Update: {
          requested_at?: string
          requested_by?: string | null
          storage_path?: string
        }
        Relationships: []
      }
      push_endpoint_rejections: {
        Row: {
          attempts: number
          first_seen_at: string
          host: string
          last_seen_at: string
          last_user_agent: string | null
        }
        Insert: {
          attempts?: number
          first_seen_at?: string
          host: string
          last_seen_at?: string
          last_user_agent?: string | null
        }
        Update: {
          attempts?: number
          first_seen_at?: string
          host?: string
          last_seen_at?: string
          last_user_agent?: string | null
        }
        Relationships: []
      }
      push_self_test_quota: {
        Row: {
          last_sent_at: string | null
          member_id: string
          sent_in_window: number
          window_started_at: string
        }
        Insert: {
          last_sent_at?: string | null
          member_id: string
          sent_in_window?: number
          window_started_at?: string
        }
        Update: {
          last_sent_at?: string | null
          member_id?: string
          sent_in_window?: number
          window_started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_self_test_quota_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: true
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_self_test_quota_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: true
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          member_id: string
          p256dh: string
          updated_at: string
          user_agent: string | null
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          member_id: string
          p256dh: string
          updated_at?: string
          user_agent?: string | null
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          member_id?: string
          p256dh?: string
          updated_at?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      record_uploads: {
        Row: {
          category: string
          created_at: string
          file_name: string
          id: string
          mime_type: string
          note: string | null
          storage_path: string
          uploaded_by: string
        }
        Insert: {
          category?: string
          created_at?: string
          file_name: string
          id?: string
          mime_type?: string
          note?: string | null
          storage_path: string
          uploaded_by: string
        }
        Update: {
          category?: string
          created_at?: string
          file_name?: string
          id?: string
          mime_type?: string
          note?: string | null
          storage_path?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "record_uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "record_uploads_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
        ]
      }
      records: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          distance_m: number
          event_date: string
          event_name: string
          id: string
          member_id: string
          metadata: Json
          result_centiseconds: number
          result_display: string
          stroke: string
          subcategory: string
          teammates: string[]
          updated_at: string
          upload_id: string | null
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          distance_m: number
          event_date: string
          event_name?: string
          id?: string
          member_id: string
          metadata?: Json
          result_centiseconds: number
          result_display: string
          stroke: string
          subcategory?: string
          teammates?: string[]
          updated_at?: string
          upload_id?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          distance_m?: number
          event_date?: string
          event_name?: string
          id?: string
          member_id?: string
          metadata?: Json
          result_centiseconds?: number
          result_display?: string
          stroke?: string
          subcategory?: string
          teammates?: string[]
          updated_at?: string
          upload_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "records_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "member_public_v"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "records_member_id_fkey"
            columns: ["member_id"]
            isOneToOne: false
            referencedRelation: "members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "records_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "record_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      schema_migrations: {
        Row: {
          applied_at: string
          version: string
        }
        Insert: {
          applied_at?: string
          version: string
        }
        Update: {
          applied_at?: string
          version?: string
        }
        Relationships: []
      }
      signup_attempt_quota: {
        Row: {
          attempts_in_window: number
          client_key: string
          last_attempt_at: string | null
          window_started_at: string
        }
        Insert: {
          attempts_in_window?: number
          client_key: string
          last_attempt_at?: string | null
          window_started_at?: string
        }
        Update: {
          attempts_in_window?: number
          client_key?: string
          last_attempt_at?: string | null
          window_started_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      activity_seats_v: {
        Row: {
          activity_id: string | null
          participant_count: number | null
          reserved_count: number | null
          waitlist_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "activity_applications_activity_id_fkey"
            columns: ["activity_id"]
            isOneToOne: false
            referencedRelation: "activities"
            referencedColumns: ["id"]
          },
        ]
      }
      member_public_v: {
        Row: {
          avatar_path: string | null
          id: string | null
          nickname: string | null
          role: string | null
          short_name: string | null
          status: string | null
          team_role: string | null
        }
        Insert: {
          avatar_path?: string | null
          id?: string | null
          nickname?: string | null
          role?: string | null
          short_name?: string | null
          status?: string | null
          team_role?: string | null
        }
        Update: {
          avatar_path?: string | null
          id?: string | null
          nickname?: string | null
          role?: string | null
          short_name?: string | null
          status?: string | null
          team_role?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      append_notice_comment: {
        Args: { p_body: string; p_notice_id: string }
        Returns: {
          body: string
          created_at: string
          id: string
          member_id: string
          notice_id: string
        }
        SetofOptions: {
          from: "*"
          to: "notice_comments"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      apply_to_activity: {
        Args: { p_activity_id: string }
        Returns: {
          activity_id: string
          application_type: string
          created_at: string
          details: Json
          id: string
          member_id: string
          offer_expires_at: string | null
          offer_status: string
          updated_at: string
          wait_order: number | null
        }
        SetofOptions: {
          from: "*"
          to: "activity_applications"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      attendance_for_activity_v1: {
        Args: { p_activity_id: string }
        Returns: {
          avatar_path: string
          late_fee_paid: boolean
          marked_at: string
          member_id: string
          nickname: string
          status: string
        }[]
      }
      attendance_mark_v1: {
        Args: {
          p_activity_id: string
          p_late_fee_paid?: boolean
          p_member_id: string
          p_status: string
        }
        Returns: {
          activity_id: string
          id: string
          late_fee_amount: number | null
          late_fee_paid: boolean
          marked_at: string
          marked_by: string
          member_id: string
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "attendance"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      attendance_my_history_v1: {
        Args: { p_from?: string; p_to?: string }
        Returns: {
          activity_date: string
          activity_id: string
          late_fee_paid: boolean
          status: string
          title: string
        }[]
      }
      board_post_text: {
        Args: { p_field: string; p_max: number; p_value: string }
        Returns: string
      }
      can_manage_records: { Args: never; Returns: boolean }
      clear_object_deletions_v1: {
        Args: { p_paths: string[] }
        Returns: string[]
      }
      create_board_post_v1: {
        Args: { p_body: string; p_title: string }
        Returns: {
          author_id: string
          body: string
          created_at: string
          id: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "board_posts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      current_member_id: { Args: never; Returns: string }
      delete_board_post_v1: { Args: { p_post_id: string }; Returns: string }
      delete_media_folder_v1: {
        Args: { p_folder_id: string }
        Returns: string[]
      }
      expire_stale_offers: { Args: never; Returns: number }
      expire_stale_offers_for_activity: {
        Args: { p_activity_id: string; p_skip_locked?: boolean }
        Returns: number
      }
      is_master_admin: { Args: never; Returns: boolean }
      is_my_avatar_object_path: { Args: { p_path: string }; Returns: boolean }
      is_my_media_object_path: { Args: { p_path: string }; Returns: boolean }
      is_my_team_file_path: { Args: { p_path: string }; Returns: boolean }
      is_push_endpoint: { Args: { p_endpoint: string }; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
      link_member_login_v1: {
        Args: { p_signup_member_id: string; p_target_member_id: string }
        Returns: Json
      }
      media_object_is_claimed: { Args: { p_path: string }; Returns: boolean }
      member_is_staff: { Args: { p_member: string }; Returns: boolean }
      member_link_board_v1: { Args: never; Returns: Json }
      my_achievement_v1: { Args: { p_year?: number }; Returns: Json }
      my_monthly_activity_v1: {
        Args: { p_month: number; p_year: number }
        Returns: Json
      }
      offer_seat_to_next_waitlister: {
        Args: { p_activity_id: string }
        Returns: string
      }
      push_endpoint_host: { Args: { p_endpoint: string }; Returns: string }
      push_notify_context_v1: {
        Args: { p_event: string; p_id: string }
        Returns: Json
      }
      push_self_test_allow_v1: { Args: { p_member: string }; Returns: Json }
      push_subscription_register_v1: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_p256dh: string
          p_user_agent?: string
        }
        Returns: string
      }
      race_my_history_v1: {
        Args: never
        Returns: {
          activity_date: string
          source: string
          status: string
          title: string
        }[]
      }
      record_unsupported_push_endpoint_v1: {
        Args: { p_endpoint: string; p_user_agent?: string }
        Returns: undefined
      }
      register_member_v1: {
        Args: { p_nickname: string; p_password: string }
        Returns: Json
      }
      request_push_notify: {
        Args: { p_event: string; p_id: string }
        Returns: undefined
      }
      respond_waitlist_offer: {
        Args: { p_accept: boolean; p_activity_id: string }
        Returns: {
          activity_id: string
          application_type: string
          created_at: string
          details: Json
          id: string
          member_id: string
          offer_expires_at: string | null
          offer_status: string
          updated_at: string
          wait_order: number | null
        }
        SetofOptions: {
          from: "*"
          to: "activity_applications"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      save_notice_v1: {
        Args: {
          p_attachments: Json
          p_body: string
          p_notice_id: string | null
          p_title: string
        }
        Returns: Json
      }
      send_message_v1: {
        Args: {
          p_attachment_path?: string
          p_attachment_type?: string
          p_body?: string
          p_recipient_id?: string
          p_room_type: string
        }
        Returns: {
          attachment_path: string | null
          attachment_type: string | null
          body: string | null
          created_at: string
          id: string
          recipient_id: string | null
          room_type: string
          sender_id: string
        }
        SetofOptions: {
          from: "*"
          to: "messages"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_member_blocked_v1: {
        Args: { p_blocked: boolean; p_member_id: string }
        Returns: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_member_role_v1: {
        Args: { p_member_id: string; p_role: string }
        Returns: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_member_status_v1: {
        Args: { p_member_id: string; p_status: string }
        Returns: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_member_team_role_v1: {
        Args: { p_member_id: string; p_team_role: string }
        Returns: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_my_avatar_path_v1: {
        Args: { p_avatar_path: string }
        Returns: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_my_real_name_v1: {
        Args: { p_real_name: string }
        Returns: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      set_signup_pass_v1: {
        Args: { p_allowed: boolean; p_member_id: string }
        Returns: {
          auth_user_id: string | null
          avatar_path: string | null
          birth_date_text: string | null
          birth_year: number | null
          created_at: string
          gender: string | null
          historical_attendance_count_legacy: number
          historical_late_count_legacy: number
          id: string
          join_date_text: string | null
          join_reason: string | null
          lesson_level: string | null
          location: string | null
          nickname: string
          notes: string | null
          real_name: string | null
          role: string
          short_name: string | null
          signup_pass_expires_at: string | null
          status: string
          swim_experience: string | null
          team_role: string | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "members"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      signup_client_key: { Args: never; Returns: string }
      team_event_rankings_v1: { Args: never; Returns: Json }
      team_file_is_readable: { Args: { p_path: string }; Returns: boolean }
      update_board_post_v1: {
        Args: {
          p_body: string
          p_expected_updated_at: string
          p_post_id: string
          p_title: string
        }
        Returns: {
          author_id: string
          body: string
          created_at: string
          id: string
          title: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "board_posts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_record: {
        Args: {
          p_category: string
          p_distance_m: number
          p_event_date: string
          p_event_name?: string
          p_member_id: string
          p_metadata?: Json
          p_result_centiseconds: number
          p_result_display: string
          p_stroke: string
          p_subcategory: string
          p_teammates?: string[]
          p_upload_id?: string
        }
        Returns: {
          category: string
          created_at: string
          created_by: string | null
          distance_m: number
          event_date: string
          event_name: string
          id: string
          member_id: string
          metadata: Json
          result_centiseconds: number
          result_display: string
          stroke: string
          subcategory: string
          teammates: string[]
          updated_at: string
          upload_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "records"
          isOneToOne: true
          isSetofReturn: false
        }
      }
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

