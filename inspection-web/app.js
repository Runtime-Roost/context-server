const state = { snapshot: null, editing: null };
const byId = (id) => document.getElementById(id);
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function relativeTime(value) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return relative.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  return relative.format(Math.round(hours / 24), "day");
}

function actorName(actor) {
  return actor?.name || actor?.external_id || "Unattributed";
}

function showError(message) {
  const target = byId("error");
  target.textContent = message;
  target.classList.toggle("hidden", !message);
}

function renderWhiteboard(contexts) {
  const host = byId("whiteboard");
  host.replaceChildren();
  byId("whiteboard-count").textContent = contexts.length;
  for (const context of contexts) {
    const card = byId("context-template").content.firstElementChild.cloneNode(true);
    card.querySelector(".actor").textContent = actorName(context.actor);
    const time = card.querySelector("time");
    time.textContent = relativeTime(context.updated_at);
    time.dateTime = context.updated_at;
    time.title = new Date(context.updated_at).toLocaleString();
    card.querySelector(".content").textContent = context.content;
    const tags = card.querySelector(".tags");
    for (const tag of context.tags) {
      const chip = document.createElement("span");
      chip.textContent = tag;
      tags.append(chip);
    }
    const acknowledgements = card.querySelector(".acknowledgements");
    if (context.acknowledged_by.length) {
      const label = document.createElement("span");
      label.className = "ack-label";
      label.textContent = "Acknowledged by";
      acknowledgements.append(label);
      for (const acknowledgement of context.acknowledged_by) {
        const actor = document.createElement("span");
        actor.className = "ack";
        actor.textContent = acknowledgement.name;
        actor.title = `Acknowledged ${new Date(acknowledgement.acknowledged_at).toLocaleString()}`;
        acknowledgements.append(actor);
      }
    } else {
      acknowledgements.textContent = "No actor acknowledgements";
      acknowledgements.classList.add("muted");
    }
    card.querySelector(".context-id").textContent = `#${context.id} · ${context.source || "no source"}`;
    const edit = card.querySelector(".edit");
    edit.disabled = !context.editable;
    edit.title = context.edit_blocked_reason || "Edit this whiteboard note";
    edit.addEventListener("click", () => openEditor(context));
    host.append(card);
  }
}

function renderPrivate(snapshot) {
  const channels = byId("channels");
  channels.replaceChildren();
  for (const channel of snapshot.private_channels) {
    const item = document.createElement("article");
    item.className = "channel-card";
    const names = channel.participants.map(actorName).join(" · ") || "Membership withheld";
    item.innerHTML = "<div><span class=\"lock\">PRIVATE CHANNEL</span><h3></h3><p></p></div><strong></strong>";
    item.querySelector("h3").textContent = channel.name;
    item.querySelector("p").textContent = names;
    item.querySelector("strong").textContent = `${channel.message_count} ${channel.message_count === 1 ? "message" : "messages"}`;
    channels.append(item);
  }

  const messages = byId("private-messages");
  messages.replaceChildren();
  byId("private-count").textContent = snapshot.private_messages.length;
  for (const envelope of snapshot.private_messages) {
    const row = document.createElement("article");
    row.className = "message-envelope";
    const heading = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = actorName(envelope.sender);
    const channel = document.createElement("span");
    channel.textContent = envelope.channel?.name || "Direct private message";
    heading.append(label, channel);
    const withheld = document.createElement("p");
    withheld.textContent = "Message body withheld";
    const meta = document.createElement("div");
    const time = document.createElement("time");
    time.dateTime = envelope.created_at;
    time.textContent = relativeTime(envelope.created_at);
    const ack = document.createElement("span");
    ack.textContent = envelope.acknowledgement_count
      ? `${envelope.acknowledgement_count} acknowledgement${envelope.acknowledgement_count === 1 ? "" : "s"}`
      : "No acknowledgements";
    meta.append(time, ack, document.createTextNode(`#${envelope.id}`));
    row.append(heading, withheld, meta);
    messages.append(row);
  }
}

async function refresh({ quiet = false } = {}) {
  if (!quiet) byId("health").textContent = "Refreshing";
  try {
    const response = await fetch("/api/inspection", { headers: { accept: "application/json" } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    if (body.privacy?.private_message_contents_exposed !== false) {
      throw new Error("Privacy contract missing; refusing to display private data");
    }
    state.snapshot = body;
    renderWhiteboard(body.whiteboard);
    renderPrivate(body);
    showError("");
    byId("health").textContent = "Live";
    document.querySelector(".health i").classList.add("live");
  } catch (error) {
    byId("health").textContent = "Offline";
    document.querySelector(".health i").classList.remove("live");
    showError(error.message || String(error));
  }
}

function openEditor(context) {
  if (!context.editable) return;
  state.editing = context;
  byId("editor-title").textContent = `Edit context #${context.id}`;
  byId("editor-content").value = context.content;
  byId("editor-status").textContent = "";
  byId("editor").showModal();
  byId("editor-content").focus();
}

byId("editor-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel" || !state.editing) return;
  event.preventDefault();
  const button = byId("save");
  button.disabled = true;
  byId("editor-status").textContent = "Saving…";
  try {
    const response = await fetch(`/api/whiteboard/${state.editing.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: byId("editor-content").value,
        expected_updated_at: state.editing.updated_at,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 409) {
        state.editing = body.context;
        throw new Error("Someone else changed this note. Close and reopen it to review the latest version.");
      }
      throw new Error(body.reason || body.error || `Save failed (${response.status})`);
    }
    byId("editor").close();
    await refresh({ quiet: true });
  } catch (error) {
    byId("editor-status").textContent = error.message || String(error);
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((item) => item.classList.toggle("active", item === button));
    byId("whiteboard-view").classList.toggle("hidden", button.dataset.view !== "whiteboard");
    byId("private-view").classList.toggle("hidden", button.dataset.view !== "private");
  });
});

byId("refresh").addEventListener("click", () => refresh());
void refresh();
setInterval(() => void refresh({ quiet: true }), 15_000);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js").catch(() => {});
