import { defaultAdapter } from "./_default.js";

/** 511.org: always attach api_key; agency code from Sheet (default SF). */
export const muniAdapter = {
  ...defaultAdapter,
  slug: "muni",
  notes: "511.org vehiclepositions + tripupdates: api_key + agency code.",

  buildVehicleFeedUrl(agency, apiKey) {
    if (!agency.vehiclePositionsUrl) {
      throw new Error("muni: vehiclePositionsUrl missing from sheet");
    }
    const url = new URL(agency.vehiclePositionsUrl);
    if (apiKey) url.searchParams.set("api_key", apiKey);
    url.searchParams.set("agency", agency.rtAgencyCode || "SF");
    return url.toString();
  },

  buildTripUpdateFeedUrl(agency, apiKey) {
    if (!agency.tripUpdatesUrl) {
      throw new Error("muni: tripUpdatesUrl missing from sheet");
    }
    const url = new URL(agency.tripUpdatesUrl);
    if (apiKey) url.searchParams.set("api_key", apiKey);
    url.searchParams.set("agency", agency.rtAgencyCode || "SF");
    return url.toString();
  },
};
