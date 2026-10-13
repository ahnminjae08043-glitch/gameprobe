# The planted bug

Collision is tested only at the player's new position each frame. When the player moves farther in one frame
than the player's height plus a platform's thickness, they skip over the platform entirely ("tunneling").

Walking off the right edge of the red tower drops the player onto the thin green bridge. At 60 fps the fall
moves about 27 px per frame and the player lands. When the frame rate drops to 30 fps (the game clamps dt to
1/30 s) it moves about 55 px per frame, passes through the bridge every time, falls into the pit and dies.

So the bug never shows up on a fast machine and always shows up on a slow one. gameprobe reproduces it
deterministically with `game_step { dt: 33.3 }`.

Fix: sweep the vertical move (check the segment from the old to the new position) or substep large moves.
