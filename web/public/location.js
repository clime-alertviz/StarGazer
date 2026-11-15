// Browser permission and location are shared only within this page session.
const nearby = {
  requested: false,
  point: null,
  country: null,
  area: null,
  pending: null,
};
export function locationContext() {
  return nearby;
}
export async function locate(call, status, refresh) {
  if (!nearby.pending) {
    nearby.requested = true;
    nearby.pending = new Promise((resolve, reject) => {
      if (!navigator.geolocation)
        return reject(
          new Error("Location is unavailable. Type a town or public place."),
        );
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 6000,
        maximumAge: 300000,
      });
    })
      .then(async (pos) => {
        nearby.point = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const result = await call("nearby_location", nearby.point);
        nearby.country = result.country;
        nearby.area = result.area;
        return result;
      })
      .catch(() => null);
  }
  if (status) status.textContent = "Finding nearby places…";
  const result = await nearby.pending;
  if (status?.isConnected)
    status.textContent = result
      ? `Suggestions near ${result.area}. You can also type another town.`
      : "Location unavailable. Add your town to the address, for example “street, town”.";
  if (refresh && result) refresh();
  return result;
}
