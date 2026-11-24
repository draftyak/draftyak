import { serve } from "@draftyak/sdk";
import { plugin } from "./plugin.ts";

serve(plugin.entry);
