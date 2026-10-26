-- Adds the Wave 0 board. wave_number -1 because 0 is already used for "Stopped".
-- After running: open Waves → Wave 0 → Sync, then Register Hooks.
insert into public.monday_waves (wave_number, board_id, name)
values (-1, '5031935467', 'Wave 0')
on conflict (board_id) do nothing;
