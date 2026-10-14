using UnityEngine;
using UnityEngine.InputSystem;

// WASD to move, Space to jump, mouse to turn. Rigidbody based.
[RequireComponent(typeof(Rigidbody))]
public class PlayerController : MonoBehaviour
{
    public float moveSpeed = 6f;
    public float jumpSpeed = 6.5f;
    public float lookSpeed = 0.15f;
    public bool grounded;
    public int jumps;

    Rigidbody body;
    float yaw;
    bool jumpQueued;

    void Awake()
    {
        body = GetComponent<Rigidbody>();
        body.freezeRotation = true;
        body.interpolation = RigidbodyInterpolation.None;
    }

    void Update()
    {
        var mouse = Mouse.current;
        if (mouse != null) yaw += mouse.delta.ReadValue().x * lookSpeed;
        transform.rotation = Quaternion.Euler(0, yaw, 0);
        var kb = Keyboard.current;
        if (kb != null && kb.spaceKey.wasPressedThisFrame && grounded) jumpQueued = true;
    }

    void FixedUpdate()
    {
        var kb = Keyboard.current;
        Vector2 move = Vector2.zero;
        if (kb != null)
        {
            if (kb.wKey.isPressed) move.y += 1;
            if (kb.sKey.isPressed) move.y -= 1;
            if (kb.dKey.isPressed) move.x += 1;
            if (kb.aKey.isPressed) move.x -= 1;
        }
        Vector3 dir = (transform.forward * move.y + transform.right * move.x);
        if (dir.sqrMagnitude > 1) dir.Normalize();
        var v = body.linearVelocity;
        body.linearVelocity = new Vector3(dir.x * moveSpeed, v.y, dir.z * moveSpeed);

        grounded = Physics.Raycast(transform.position, Vector3.down, 1.05f);
        if (jumpQueued)
        {
            jumpQueued = false;
            body.linearVelocity = new Vector3(body.linearVelocity.x, jumpSpeed, body.linearVelocity.z);
            jumps++;
        }
        if (transform.position.y < -10) GameManager.Instance.Respawn(this);
    }
}
