import {
  createForecastKindRegistry,
  forecastKindDefinitions,
} from "../../features/forecast-ledger/domain/forecast-kinds";
import { describeConformance } from "./kit";

// The factory's own module constructs the registry, so the run binds that
// construction's enumeration as `production`. #9709 owns the Forecast Kind
// property set; until it lands this run checks registration coverage only.
describeConformance({
  registry: createForecastKindRegistry,
  production: forecastKindDefinitions,
  entries: forecastKindDefinitions,
  key: (kind) => kind.name,
  properties: [],
});
