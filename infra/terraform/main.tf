terraform {
  required_providers {
    supabase = {
      source  = "supabase/supabase"
      version = "~> 1.0.0"
    }
  }
}

provider "supabase" {
  # Access token is pulled from SUPABASE_ACCESS_TOKEN environment variable
}

# Placeholder for future Supabase project management
# resource "supabase_project" "dojo" {
#   name            = "dojo-tcg-collection"
#   organization_id = var.org_id
#   db_password     = var.db_password
#   region          = "us-east-1"
# }
