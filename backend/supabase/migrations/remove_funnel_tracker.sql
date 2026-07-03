-- Removes the funnel tracker: drops funnel builds/QA items and restricts
-- builds.type to 'jewelry' only. Review before running against production data.
delete from public.qa_items where build_id in (select id from public.builds where type = 'funnel');
delete from public.builds where type = 'funnel';

alter table public.builds drop constraint if exists builds_type_check;
alter table public.builds add constraint builds_type_check check (type in ('jewelry'));

update public.settings
set approver_permissions = approver_permissions - 'funnel_tracker'
where approver_permissions ? 'funnel_tracker';
