const TOKEN_KEY = "apiToken";

async function render() {
  const root = document.getElementById("root");
  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);

  if (token) {
    root.innerHTML = `
      <div class="status">Connecté</div>
      <button id="logout" class="secondary">Déconnecter</button>
    `;
    document.getElementById("logout").addEventListener("click", async () => {
      await chrome.storage.local.remove(TOKEN_KEY);
      render();
    });
  } else {
    root.innerHTML = `
      <label for="token">Token API</label>
      <input id="token" type="password" placeholder="Colle ton token ici" />
      <button id="save">Enregistrer</button>
    `;
    document.getElementById("save").addEventListener("click", async () => {
      const value = document.getElementById("token").value.trim();
      if (!value) return;
      await chrome.storage.local.set({ [TOKEN_KEY]: value });
      render();
    });
  }
}

render();
