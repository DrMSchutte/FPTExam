DO $$ BEGIN
 CREATE TYPE "public"."user_source" AS ENUM('manual', 'fptstaff');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "source" "user_source" DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "fptstaff_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_fptstaff_id_unique" UNIQUE("fptstaff_id");