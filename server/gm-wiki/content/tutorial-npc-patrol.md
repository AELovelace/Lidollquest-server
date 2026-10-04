# Tutorial: build an NPC patrol

[Wiki home](index.md)

Make a guard walk around an obstacle, pause at a lookout, and return along the same path. Use a local test server or an agreed authoring zone: **Save routes changes the live placement**, not a Story Workshop preview.

## 1. Prepare a guard and a safe map

Create an NPC called **Harbour Watcher**, give it a short greeting, then save and publish its definition. Set Wander radius to 0 for an easy-to-understand baseline. In the Map Editor choose a zone with a clear walkable area, select **Place content**, choose NPC and Harbour Watcher, then place it away from arrivals and fixtures. Use Persistent if it should survive map editions.

Open the game with a test character in that zone. Keep that character away from the proposed stops. Zoom with the wheel and pan by right-dragging or Space-dragging; turn on **grid** and **reachability**. Coordinates in this guide are illustrative, not a promise about generated maps.

## 2. Choose three destinations

![Example patrol drawing around a central wall, with home, three numbered destinations and an open connecting passage.](../assets/tutorial/npc-route-map.svg "Choose equivalent reachable stops on your map; do not copy coordinates into an unrelated generated layout.")

Select **NPC routes**, click the guard and create a route named **Lookout round**. Pick three destinations in this order:

1. An open tile before the doorway or passage.
2. An open tile by the lookout on the other side of the obstacle.
3. An open tile farther along that side of the area.

The coloured line should use the passage instead of crossing the wall. If it uses another corridor, add a destination near the intended passage. Do not add a point on an actual door, chest, service fixture or exit. The terrain reachability overlay and route preview answer different questions; inspect both.

## 3. Set the behavior

Choose **Movement → Back and forth**, **When → Always**. Set waypoint 2's wait to **4 seconds**; leave points 1 and 3 at zero. A longer pause of 10–20 seconds can be easier to observe on a large map. Remove a mistaken point with its × button or Alt-click, then add the replacement at the end; rebuild later points if the order matters.

![The back-and-forth pattern visits points 1, 2, 3, 2, 1; Loop goes from the last point to the first, and Walk there and stay holds at the final stop.](../assets/tutorial/npc-route-modes.svg "The example uses Back and forth, so the return trip visits the lookout again.")

## 4. Save and watch

Choose **Save routes**. The confirmation says the guard starts again from home. Keep the test player present and watch it visit 1 → 2 → 3 → 2 → 1, with the wait at point 2 in both directions. A returning player after an empty-zone interval may see schedule catch-up rather than the approach from home.

Approach and talk to the guard: it should pause during the conversation, then resume after the hold ends. Check that players can pass it while it is moving and still reach it when it stops. The map's auto-refresh updates the observed position; the **NPC routes** overlay can be toggled without deleting anything.

## 5. Compare the other modes

In the [interactive movement demonstration](npc-routes.md#try-the-movement-demonstration), compare all three modes first. Then change the guard to **Loop**, save, and check it goes from point 3 directly toward point 1. Home is not an extra loop point unless you explicitly included its tile. Change to **Walk there and stay** and save again: the guard visits the stops and remains at point 3. Return to Back and forth when finished.

## 6. Try a safe terrain edit

On a test map that permits terrain patches, choose **Terrain brush**, select a one-tile Wall brush and paint a harmless tile away from arrivals, objectives and the patrol. The change appears in **Pending changes**. Use **Undo** to remove it, **Redo** to preview it again, then **Discard** if you do not want to commit. This queue is separate from route editing.

For a committed experiment, paint a nonessential tile with a clear alternative path and choose **Apply changes**. Refresh and inspect the route. If the server says the edit would strand a service or cover protected content, choose a different tile. Use **Remove** for that stored patch operation, or roll back to the previous patch revision; **Clear patch** removes the entire zone patch, so use it only when all changes in that test zone are yours to discard.

## Completion check

- The guard is a managed NPC placement with a known home.
- The route has three reachable stops and the intended four-second wait.
- Back and forth reverses the destination order instead of jumping home.
- A conversation pauses movement, and movement resumes afterward.
- Another GM can refresh the zone, select the guard and see the saved route.
- Terrain changes and route changes were saved through their separate controls.

Next: [give this NPC daily work hours or an interval round](tutorial-npc-schedules.md).
