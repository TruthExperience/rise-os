import type { TeamTraits, DriverStats } from "./setup-engine";

export async function fetchTeamTraits(teamId: string): Promise<TeamTraits | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("car_class_teams")
    .select("aero_efficiency, engine_power, mechanical_grip, reliability, drag_efficiency, tyre_wear_management")
    .eq("id", teamId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load team traits: ${error.message}`);
  if (!data) return null;

  return {
    aero_efficiency: Number(data.aero_efficiency ?? 0),
    engine_power: Number(data.engine_power ?? 0),
    mechanical_grip: Number(data.mechanical_grip ?? 0),
    reliability: Number(data.reliability ?? 0),
    drag_efficiency: Number(data.drag_efficiency ?? 0),
    tyre_wear_management: Number(data.tyre_wear_management ?? 0),
  };
}

export async function fetchCareerDriverStats(careerDriverId: string): Promise<DriverStats | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .schema("pitboss")
    .from("career_mode_drivers")
    .select("pace, racecraft, awareness, experience")
    .eq("id", careerDriverId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load career driver stats: ${error.message}`);
  if (!data) return null;

  return {
    pace: Number(data.pace ?? 50),
    racecraft: Number(data.racecraft ?? 50),
    awareness: Number(data.awareness ?? 50),
    experience: Number(data.experience ?? 50),
  };
}
