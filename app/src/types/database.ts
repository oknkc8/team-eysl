export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
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
          status?: string
          swim_experience?: string | null
          team_role?: string | null
          updated_at?: string
        }
        Relationships: []
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
    }
    Views: {
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
      current_member_id: { Args: never; Returns: string }
      expire_stale_offers: { Args: never; Returns: number }
      is_master_admin: { Args: never; Returns: boolean }
      is_staff: { Args: never; Returns: boolean }
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

