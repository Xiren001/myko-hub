-- Removes Mistake Log, Monthly Planner, Decision Rights, and Team Tasks.
-- team_tasks/team_members were never in schema.sql (created directly in
-- Supabase) — review before running against production data.
drop table if exists public.mistakes;
drop table if exists public.planner_notes;
drop table if exists public.decision_rights;
drop table if exists public.team_tasks;
drop table if exists public.team_members;

update public.settings
set approver_permissions = approver_permissions - 'mistake_log' - 'monthly_planner' - 'decision_rights' - 'team_tasks'
where approver_permissions ?| array['mistake_log', 'monthly_planner', 'decision_rights', 'team_tasks'];
