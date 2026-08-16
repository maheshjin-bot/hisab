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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      account_groups: {
        Row: {
          company_id: string
          created_at: string
          id: string
          is_system: boolean
          ledger_role: string
          name: string
          nature: string
          normal_balance: string
          parent_group_id: string | null
          sort_order: number
          statement: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          is_system?: boolean
          ledger_role?: string
          name: string
          nature: string
          normal_balance: string
          parent_group_id?: string | null
          sort_order?: number
          statement?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          is_system?: boolean
          ledger_role?: string
          name?: string
          nature?: string
          normal_balance?: string
          parent_group_id?: string | null
          sort_order?: number
          statement?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "account_groups_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_groups_parent_group_id_company_id_fkey"
            columns: ["parent_group_id", "company_id"]
            isOneToOne: false
            referencedRelation: "account_groups"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          changed_at: string
          changed_by: string | null
          company_id: string
          id: string
          new_data: Json | null
          old_data: Json | null
          record_id: string
          table_name: string
        }
        Insert: {
          action: string
          changed_at?: string
          changed_by?: string | null
          company_id: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id: string
          table_name: string
        }
        Update: {
          action?: string
          changed_at?: string
          changed_by?: string | null
          company_id?: string
          id?: string
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string
          table_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          base_currency: string
          book_beginning_date: string
          created_at: string
          created_by: string | null
          financial_year_start_month: number
          id: string
          is_active: boolean
          lock_date: string | null
          name: string
          updated_at: string
        }
        Insert: {
          base_currency?: string
          book_beginning_date: string
          created_at?: string
          created_by?: string | null
          financial_year_start_month?: number
          id?: string
          is_active?: boolean
          lock_date?: string | null
          name: string
          updated_at?: string
        }
        Update: {
          base_currency?: string
          book_beginning_date?: string
          created_at?: string
          created_by?: string | null
          financial_year_start_month?: number
          id?: string
          is_active?: boolean
          lock_date?: string | null
          name?: string
          updated_at?: string
        }
        Relationships: []
      }
      company_invites: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          company_id: string
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: string
          status: string
          token: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id: string
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_by: string
          role: string
          status?: string
          token?: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: string
          status?: string
          token?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_invites_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_members: {
        Row: {
          company_id: string
          created_at: string
          id: string
          invited_by: string | null
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          invited_by?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_members_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      import_batch_rows: {
        Row: {
          batch_id: string
          company_id: string
          id: string
          raw_data: Json
          resolved_entity_id: string | null
          row_number: number
          validation_errors: Json | null
          validation_status: string
        }
        Insert: {
          batch_id: string
          company_id: string
          id?: string
          raw_data: Json
          resolved_entity_id?: string | null
          row_number: number
          validation_errors?: Json | null
          validation_status?: string
        }
        Update: {
          batch_id?: string
          company_id?: string
          id?: string
          raw_data?: Json
          resolved_entity_id?: string | null
          row_number?: number
          validation_errors?: Json | null
          validation_status?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batch_rows_batch_id_company_id_fkey"
            columns: ["batch_id", "company_id"]
            isOneToOne: false
            referencedRelation: "import_batches"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      import_batches: {
        Row: {
          committed_at: string | null
          company_id: string
          created_at: string
          created_by: string | null
          error_count: number
          file_name: string | null
          id: string
          import_type: string
          row_count: number
          status: string
        }
        Insert: {
          committed_at?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          error_count?: number
          file_name?: string | null
          id?: string
          import_type: string
          row_count?: number
          status?: string
        }
        Update: {
          committed_at?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          error_count?: number
          file_name?: string | null
          id?: string
          import_type?: string
          row_count?: number
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_batches_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      ledgers: {
        Row: {
          address: string | null
          company_id: string
          contact_person: string | null
          created_at: string
          created_by: string | null
          email: string | null
          group_id: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          opening_balance_amount: number
          opening_balance_type: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          company_id: string
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          group_id: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          opening_balance_amount?: number
          opening_balance_type?: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          company_id?: string
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          group_id?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          opening_balance_amount?: number
          opening_balance_type?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ledgers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ledgers_group_id_company_id_fkey"
            columns: ["group_id", "company_id"]
            isOneToOne: false
            referencedRelation: "account_groups"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
        }
        Relationships: []
      }
      voucher_entries: {
        Row: {
          company_id: string
          created_at: string
          credit_amount: number
          debit_amount: number
          id: string
          ledger_id: string
          line_order: number
          narration: string | null
          updated_at: string
          voucher_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          id?: string
          ledger_id: string
          line_order?: number
          narration?: string | null
          updated_at?: string
          voucher_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          credit_amount?: number
          debit_amount?: number
          id?: string
          ledger_id?: string
          line_order?: number
          narration?: string | null
          updated_at?: string
          voucher_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_entries_ledger_id_company_id_fkey"
            columns: ["ledger_id", "company_id"]
            isOneToOne: false
            referencedRelation: "ledgers"
            referencedColumns: ["id", "company_id"]
          },
          {
            foreignKeyName: "voucher_entries_voucher_id_company_id_fkey"
            columns: ["voucher_id", "company_id"]
            isOneToOne: false
            referencedRelation: "vouchers"
            referencedColumns: ["id", "company_id"]
          },
        ]
      }
      voucher_number_sequences: {
        Row: {
          company_id: string
          financial_year_label: string
          next_number: number
          padding: number
          prefix: string
          voucher_type: string
        }
        Insert: {
          company_id: string
          financial_year_label: string
          next_number?: number
          padding?: number
          prefix: string
          voucher_type: string
        }
        Update: {
          company_id?: string
          financial_year_label?: string
          next_number?: number
          padding?: number
          prefix?: string
          voucher_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "voucher_number_sequences_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      vouchers: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          financial_year_label: string
          id: string
          is_deleted: boolean
          narration: string | null
          reference_date: string | null
          reference_number: string | null
          sequence_number: number
          total_amount: number
          updated_at: string
          updated_by: string | null
          voucher_date: string
          voucher_number: string
          voucher_type: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          financial_year_label: string
          id?: string
          is_deleted?: boolean
          narration?: string | null
          reference_date?: string | null
          reference_number?: string | null
          sequence_number: number
          total_amount?: number
          updated_at?: string
          updated_by?: string | null
          voucher_date: string
          voucher_number: string
          voucher_type: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          financial_year_label?: string
          id?: string
          is_deleted?: boolean
          narration?: string | null
          reference_date?: string | null
          reference_number?: string | null
          sequence_number?: number
          total_amount?: number
          updated_at?: string
          updated_by?: string | null
          voucher_date?: string
          voucher_number?: string
          voucher_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "vouchers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      accept_company_invite: { Args: { p_token: string }; Returns: string }
      create_company: {
        Args: {
          p_base_currency?: string
          p_book_beginning_date: string
          p_financial_year_start_month?: number
          p_name: string
        }
        Returns: string
      }
      create_voucher: {
        Args: {
          p_company_id: string
          p_lines: Json
          p_narration: string
          p_reference_date: string
          p_reference_number: string
          p_voucher_date: string
          p_voucher_type: string
        }
        Returns: string
      }
      create_vouchers_bulk: {
        Args: { p_company_id: string; p_groups: Json }
        Returns: {
          error_message: string
          group_key: string
          voucher_id: string
        }[]
      }
      get_balance_sheet: {
        Args: { p_as_of_date: string; p_company_id: string }
        Returns: {
          amount: number
          group_name: string
          ledger_id: string
          ledger_name: string
          nature: string
          side: string
        }[]
      }
      get_dashboard_summary: {
        Args: { p_as_of_date: string; p_company_id: string }
        Returns: {
          bank_balance: number
          bank_balance_change: number
          cash_in_hand: number
          cash_in_hand_change: number
          month_inflow: number
          month_outflow: number
        }[]
      }
      get_daybook: {
        Args: { p_company_id: string; p_from_date: string; p_to_date: string }
        Returns: {
          cr_ledgers: string
          dr_ledgers: string
          narration: string
          total_amount: number
          voucher_date: string
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_ledger_statement: {
        Args: {
          p_company_id: string
          p_from_date: string
          p_ledger_id: string
          p_to_date: string
        }
        Returns: {
          credit_amount: number
          debit_amount: number
          entry_date: string
          narration: string
          running_balance: number
          voucher_id: string
          voucher_number: string
          voucher_type: string
        }[]
      }
      get_profit_and_loss: {
        Args: { p_company_id: string; p_from_date: string; p_to_date: string }
        Returns: {
          amount: number
          group_name: string
          ledger_id: string
          ledger_name: string
          nature: string
          statement: string
        }[]
      }
      get_trial_balance: {
        Args: { p_as_of_date: string; p_company_id: string }
        Returns: {
          credit_balance: number
          debit_balance: number
          group_name: string
          ledger_id: string
          ledger_name: string
          nature: string
        }[]
      }
      update_voucher: {
        Args: {
          p_lines: Json
          p_narration: string
          p_reference_date: string
          p_reference_number: string
          p_voucher_date: string
          p_voucher_id: string
        }
        Returns: string
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
  public: {
    Enums: {},
  },
} as const
