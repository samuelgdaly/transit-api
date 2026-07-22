/** @typedef {import('./types.js').AgencyAdapter} AgencyAdapter */

/** @type {Omit<AgencyAdapter, 'slug'>} */
export const defaultAdapter = {
  notes: "GTFS-RT matching: trip.routeId, then trips.txt join.",

  buildVehicleFeedUrl(agency, apiKey) {
    if (!agency.vehiclePositionsUrl) {
      throw new Error(`${agency.slug || "agency"}: vehiclePositionsUrl missing from sheet`);
    }
    const url = new URL(agency.vehiclePositionsUrl);
    if (apiKey && !url.searchParams.has("api_key") && !url.searchParams.has("apiKey")) {
      url.searchParams.set("api_key", apiKey);
    }
    if (agency.rtAgencyCode) {
      url.searchParams.set("agency", agency.rtAgencyCode);
    }
    return url.toString();
  },

  buildTripUpdateFeedUrl(agency, apiKey) {
    if (!agency.tripUpdatesUrl) {
      throw new Error(`${agency.slug || "agency"}: tripUpdatesUrl missing from sheet`);
    }
    const url = new URL(agency.tripUpdatesUrl);
    if (apiKey && !url.searchParams.has("api_key") && !url.searchParams.has("apiKey")) {
      url.searchParams.set("api_key", apiKey);
    }
    if (agency.rtAgencyCode) {
      url.searchParams.set("agency", agency.rtAgencyCode);
    }
    return url.toString();
  },

  normalizeRouteId(id) {
    return String(id ?? "").trim();
  },

  extractRouteId(entity, staticIndex) {
    const trip = entity?.vehicle?.trip || entity?.tripUpdate?.trip || {};
    const direct = this.normalizeRouteId(trip.routeId);
    if (direct && staticIndex.routeIds.has(direct)) {
      return { routeId: direct, method: "trip.routeId" };
    }
    if (direct) {
      return { routeId: direct, method: "trip.routeId(unverified)" };
    }

    const tripId = this.normalizeRouteId(trip.tripId);
    if (tripId && staticIndex.tripToRoute.has(tripId)) {
      return {
        routeId: staticIndex.tripToRoute.get(tripId),
        method: "trips.txt",
      };
    }

    return { routeId: null, method: "unmatched" };
  },
};
