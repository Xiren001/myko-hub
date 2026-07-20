import { supabase } from '../supabase'

// When true, the Waves/BioEdge login + notification separation is relaxed:
// any login can see both systems' data, and BioEdge auto-notifications
// reuse the Waves email list/delay instead of their own.
export async function isBioedgeSharingEnabled(): Promise<boolean> {
  const { data } = await supabase.from('settings').select('share_bioedge_with_waves').eq('id', 1).single()
  return data?.share_bioedge_with_waves === true
}
