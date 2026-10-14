using UnityEngine;

public class GameManager : MonoBehaviour
{
    public static GameManager Instance;
    public int score;
    public int totalCoins;
    public int falls;
    public Vector3 spawn = new Vector3(0, 1, 0);

    void Awake()
    {
        Instance = this;
        totalCoins = FindObjectsByType<Coin>(FindObjectsSortMode.None).Length;
    }

    public void Collect(Coin c) { score++; }

    public void Respawn(PlayerController p)
    {
        falls++;
        p.transform.position = spawn;
        p.GetComponent<Rigidbody>().linearVelocity = Vector3.zero;
    }

    void OnGUI()
    {
        GUI.Label(new Rect(12, 10, 400, 30), "<size=22>Coins " + score + " / " + totalCoins + "</size>");
    }
}
