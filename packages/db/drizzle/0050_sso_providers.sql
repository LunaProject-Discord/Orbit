CREATE TYPE "public"."sso_token_auth_method" AS ENUM('client_secret_basic', 'client_secret_post');--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_encrypted" text NOT NULL,
	"discovery_url" text,
	"authorization_url" text,
	"token_url" text,
	"user_info_url" text,
	"scopes" text NOT NULL,
	"subject_claim" text DEFAULT 'sub' NOT NULL,
	"email_claim" text DEFAULT 'email' NOT NULL,
	"name_claim" text DEFAULT 'name' NOT NULL,
	"token_auth_method" "sso_token_auth_method" DEFAULT 'client_secret_basic' NOT NULL,
	"use_pkce" boolean DEFAULT true NOT NULL,
	"allow_sign_up" boolean DEFAULT false NOT NULL,
	"allowed_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"trust_email" boolean DEFAULT false NOT NULL,
	"skip_two_factor" boolean DEFAULT false NOT NULL,
	"suggest_mail_account" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_account_idx" ON "auth_accounts" USING btree ("provider_id","account_id");