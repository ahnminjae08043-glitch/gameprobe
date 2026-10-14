using UnityEngine;

public class Coin : MonoBehaviour
{
    void Update() { transform.Rotate(0, 120 * Time.deltaTime, 0); }

    void OnTriggerEnter(Collider other)
    {
        if (other.GetComponentInParent<PlayerController>() == null) return;
        GameManager.Instance.Collect(this);
        Destroy(gameObject);
    }
}
