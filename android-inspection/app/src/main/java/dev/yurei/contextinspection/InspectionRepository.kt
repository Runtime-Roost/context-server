package dev.yurei.contextinspection

import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

data class Actor(val name: String, val externalId: String?)
data class Acknowledgement(val name: String, val acknowledgedAt: String)
data class WhiteboardContext(
    val id: Long,
    val content: String,
    val source: String?,
    val tags: List<String>,
    val actor: Actor?,
    val acknowledgements: List<Acknowledgement>,
    val updatedAt: String,
    val editable: Boolean,
    val blockedReason: String?,
)
data class PrivateChannel(
    val id: Long,
    val name: String,
    val participants: List<Actor>,
    val messageCount: Int,
)
data class PrivateEnvelope(
    val id: Long,
    val channelName: String?,
    val sender: Actor?,
    val acknowledgementCount: Int,
    val createdAt: String,
)
data class InspectionSnapshot(
    val whiteboard: List<WhiteboardContext>,
    val channels: List<PrivateChannel>,
    val envelopes: List<PrivateEnvelope>,
)

class InspectionRepository(private val token: String) {
    suspend fun snapshot(): InspectionSnapshot {
        val root = request("GET", "/api/inspection")
        check(root.getJSONObject("privacy").getBoolean("private_message_contents_exposed").not()) {
            "Privacy contract missing"
        }
        return InspectionSnapshot(
            whiteboard = root.getJSONArray("whiteboard").objects().map { item ->
                WhiteboardContext(
                    id = item.getLong("id"),
                    content = item.getString("content"),
                    source = item.stringOrNull("source"),
                    tags = item.getJSONArray("tags").strings(),
                    actor = item.objectOrNull("actor")?.actor(),
                    acknowledgements = item.getJSONArray("acknowledged_by").objects().map {
                        Acknowledgement(it.getString("name"), it.getString("acknowledged_at"))
                    },
                    updatedAt = item.getString("updated_at"),
                    editable = item.getBoolean("editable"),
                    blockedReason = item.stringOrNull("edit_blocked_reason"),
                )
            },
            channels = root.getJSONArray("private_channels").objects().map { item ->
                PrivateChannel(
                    id = item.getLong("id"),
                    name = item.getString("name"),
                    participants = item.getJSONArray("participants").objects().map(JSONObject::actor),
                    messageCount = item.getInt("message_count"),
                )
            },
            envelopes = root.getJSONArray("private_messages").objects().map { item ->
                PrivateEnvelope(
                    id = item.getLong("id"),
                    channelName = item.objectOrNull("channel")?.getString("name"),
                    sender = item.objectOrNull("sender")?.actor(),
                    acknowledgementCount = item.getInt("acknowledgement_count"),
                    createdAt = item.getString("created_at"),
                )
            },
        )
    }

    suspend fun update(context: WhiteboardContext, content: String) {
        request(
            "PATCH",
            "/api/whiteboard/${context.id}",
            JSONObject()
                .put("content", content)
                .put("expected_updated_at", context.updatedAt),
        )
    }

    suspend fun create(content: String) {
        request(
            "POST",
            "/api/whiteboard",
            JSONObject().put("content", content),
        )
    }

    suspend fun delete(context: WhiteboardContext) {
        request(
            "DELETE",
            "/api/whiteboard/${context.id}",
            JSONObject().put("expected_updated_at", context.updatedAt),
        )
    }

    private suspend fun request(method: String, path: String, body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) {
            require(token.length >= 32) { "Phone is not enrolled" }
            val connection = URL("${BuildConfig.INSPECTION_BASE_URL}$path")
                .openConnection() as HttpURLConnection
            try {
                connection.requestMethod = method
                connection.connectTimeout = 3_000
                connection.readTimeout = 12_000
                connection.setRequestProperty("Authorization", "Bearer $token")
                connection.setRequestProperty("Accept", "application/json")
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.outputStream.use { it.write(body.toString().encodeToByteArray()) }
                }
                val status = connection.responseCode
                val stream = if (status in 200..299) connection.inputStream else connection.errorStream
                val payload = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                if (status !in 200..299) {
                    val error = runCatching {
                        JSONObject(payload).optString("reason").ifBlank {
                            JSONObject(payload).optString("error")
                        }
                    }.getOrNull()
                    throw IllegalStateException(error?.ifBlank { "Gateway returned $status" }
                        ?: "Gateway returned $status")
                }
                JSONObject(payload)
            } finally {
                connection.disconnect()
            }
        }
}

private fun JSONObject.actor() = Actor(
    name = optString("name").ifBlank { optString("external_id", "Unknown actor") },
    externalId = stringOrNull("external_id"),
)

private fun JSONObject.objectOrNull(key: String): JSONObject? =
    if (isNull(key)) null else optJSONObject(key)

private fun JSONObject.stringOrNull(key: String): String? =
    if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

private fun org.json.JSONArray.objects(): List<JSONObject> =
    (0 until length()).mapNotNull(::optJSONObject)

private fun org.json.JSONArray.strings(): List<String> =
    (0 until length()).mapNotNull { optString(it).takeIf(String::isNotBlank) }
