package dev.yurei.contextinspection

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val Ink = Color(0xFF18251F)
private val Paper = Color(0xFFEEF1EC)
private val Forest = Color(0xFF276344)
private val ForestSoft = Color(0xFFDCEBE1)
private val Muted = Color(0xFF66736C)
private val AmberSoft = Color(0xFFF5E8CB)
private val Amber = Color(0xFF8A5918)

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(
                colorScheme = MaterialTheme.colorScheme.copy(
                    primary = Forest,
                    background = Paper,
                    surface = Color(0xFFFBFCFA),
                    onSurface = Ink,
                ),
            ) {
                Surface(Modifier.fillMaxSize(), color = Paper) {
                    InspectionApp(
                        initialToken = getPreferences(MODE_PRIVATE).getString("mobile_token", "").orEmpty(),
                        saveToken = {
                            getPreferences(MODE_PRIVATE).edit().putString("mobile_token", it).apply()
                        },
                    )
                }
            }
        }
    }
}

private enum class View { WHITEBOARD, PRIVATE, ARCHIVE }

@Composable
private fun InspectionApp(initialToken: String, saveToken: (String) -> Unit) {
    var token by remember { mutableStateOf(initialToken) }
    var draftToken by remember { mutableStateOf("") }
    if (token.length < 32) {
        Enrollment(draftToken, { draftToken = it }) {
            token = draftToken.trim()
            saveToken(token)
        }
        return
    }

    val repository = remember(token) { InspectionRepository(token) }
    val scope = rememberCoroutineScope()
    var snapshot by remember { mutableStateOf<InspectionSnapshot?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var view by remember { mutableStateOf(View.WHITEBOARD) }
    var editing by remember { mutableStateOf<WhiteboardContext?>(null) }
    var creating by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<WhiteboardContext?>(null) }
    var archiving by remember { mutableStateOf<WhiteboardContext?>(null) }

    suspend fun refresh() {
        runCatching { repository.snapshot() }
            .onSuccess { snapshot = it; error = null }
            .onFailure { error = it.message ?: "Inspection gateway unavailable" }
    }
    LaunchedEffect(repository) {
        while (true) {
            refresh()
            delay(15_000)
        }
    }

    LazyColumn(
        Modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        item { Header(error == null && snapshot != null) }
        error?.let { item { ErrorCard(it) } }
        item {
            Row(
                Modifier.padding(horizontal = 16.dp).horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(
                    selected = view == View.WHITEBOARD,
                    onClick = { view = View.WHITEBOARD },
                    label = { Text("Whiteboard ${snapshot?.whiteboard?.size ?: "—"}") },
                )
                FilterChip(
                    selected = view == View.PRIVATE,
                    onClick = { view = View.PRIVATE },
                    label = { Text("Private mail ${snapshot?.envelopes?.size ?: "—"}") },
                )
                FilterChip(
                    selected = view == View.ARCHIVE,
                    onClick = { view = View.ARCHIVE },
                    label = { Text("Archive ${snapshot?.archive?.size ?: "—"}") },
                )
            }
        }
        item {
            TextButton(
                onClick = { scope.launch { refresh() } },
                modifier = Modifier.padding(horizontal = 8.dp),
            ) { Text("Refresh") }
        }
        if (view == View.WHITEBOARD) {
            item {
                Button(
                    onClick = { creating = true },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                ) { Text("Create new note") }
            }
            snapshot?.whiteboard?.let { contexts ->
                items(contexts, key = { "whiteboard-${it.id}" }) { context ->
                    WhiteboardCard(
                        context,
                        onEdit = { editing = context },
                        onDelete = { deleting = context },
                        onArchive = { archiving = context },
                    )
                }
            }
        } else if (view == View.PRIVATE) {
            item {
                Text(
                    "Bodies withheld by server",
                    color = Forest,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 18.dp),
                )
            }
            snapshot?.channels?.let { channels ->
                items(channels, key = { "channel-${it.id}" }) { PrivateChannelCard(it) }
            }
            snapshot?.envelopes?.let { envelopes ->
                items(envelopes, key = { "envelope-${it.id}" }) { PrivateEnvelopeCard(it) }
            }
        } else {
            item {
                Text(
                    "Archived notes keep their author, acknowledgements, and attributed reason.",
                    color = Forest,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(horizontal = 18.dp),
                )
            }
            snapshot?.archive?.let { contexts ->
                items(contexts, key = { "archive-${it.id}" }) { context ->
                    ArchiveCard(context) {
                        scope.launch {
                            runCatching { repository.restore(context) }
                                .onSuccess { refresh() }
                                .onFailure { error = it.message ?: "Restore failed" }
                        }
                    }
                }
            }
        }
        item { Spacer(Modifier.size(24.dp)) }
    }

    if (creating || editing != null) {
        NoteEditorDialog(
            context = editing,
            dismiss = { editing = null; creating = false },
            save = { content ->
                scope.launch {
                    runCatching {
                        editing?.let { repository.update(it, content) } ?: repository.create(content)
                    }
                        .onSuccess { editing = null; creating = false; refresh() }
                        .onFailure { error = it.message ?: "Save failed" }
                }
            },
        )
    }
    deleting?.let { context ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete context #${context.id}?", fontFamily = FontFamily.Serif) },
            text = { Text("This removes the note and its acknowledgements. Agent inbox notes cannot be deleted here.") },
            confirmButton = {
                Button(onClick = {
                    scope.launch {
                        runCatching { repository.delete(context) }
                            .onSuccess { deleting = null; refresh() }
                            .onFailure { error = it.message ?: "Delete failed" }
                    }
                }) { Text("Delete note") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Keep note") } },
        )
    }
    archiving?.let { context ->
        ArchiveDialog(
            context = context,
            dismiss = { archiving = null },
            archive = { reason ->
                scope.launch {
                    runCatching { repository.archive(context, reason) }
                        .onSuccess { archiving = null; refresh() }
                        .onFailure { error = it.message ?: "Archive failed" }
                }
            },
        )
    }
}

@Composable
private fun Enrollment(value: String, change: (String) -> Unit, enroll: () -> Unit) {
    Column(
        Modifier.fillMaxSize().padding(28.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Label("PRIVATE DEVICE")
        Text("Inspection", fontFamily = FontFamily.Serif, fontSize = 46.sp, fontWeight = FontWeight.Bold)
        Text(
            "Enter the per-phone token created on your PC. It stays in this app's private storage.",
            color = Muted,
            modifier = Modifier.padding(vertical = 18.dp),
        )
        OutlinedTextField(
            value = value,
            onValueChange = change,
            label = { Text("Enrollment token") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = enroll,
            enabled = value.trim().length >= 32,
            modifier = Modifier.padding(top = 12.dp),
        ) { Text("Enroll this phone") }
    }
}

@Composable
private fun Header(live: Boolean) {
    Column(Modifier.fillMaxWidth().padding(20.dp)) {
        Label("PERSONAL CONTEXT · PRIVATE LAN")
        Text("Inspection", fontFamily = FontFamily.Serif, fontSize = 48.sp, fontWeight = FontWeight.Bold)
        Text(
            "Whiteboard visibility without agent control.",
            color = Muted,
            fontSize = 13.sp,
        )
        Text(
            if (live) "● Live" else "● Connecting",
            color = if (live) Forest else Amber,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}

@Composable
private fun Label(value: String) {
    Text(value, color = Muted, fontSize = 10.sp, fontWeight = FontWeight.Bold, letterSpacing = 1.5.sp)
}

@Composable
private fun ErrorCard(message: String) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFFF4DFDC)),
    ) { Text(message, color = Color(0xFF923F3A), modifier = Modifier.padding(14.dp)) }
}

@Composable
private fun WhiteboardCard(
    context: WhiteboardContext,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
    onArchive: () -> Unit,
) {
    var expanded by remember(context.id) { mutableStateOf(false) }
    val long = context.content.length > 120 || context.content.count { it == '\n' } > 2
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFFFBFCFA)),
    ) {
        Column(Modifier.padding(18.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(context.actor?.name ?: "Unattributed", fontWeight = FontWeight.Bold)
                Text(formatTime(context.updatedAt), color = Muted, fontSize = 11.sp)
            }
            Text(
                context.content,
                fontFamily = FontFamily.Serif,
                fontSize = 16.sp,
                lineHeight = 23.sp,
                maxLines = if (expanded) Int.MAX_VALUE else 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(vertical = 16.dp),
            )
            if (long) {
                TextButton(onClick = { expanded = !expanded }) {
                    Text(if (expanded) "Show less" else "Show more")
                }
            }
            if (context.tags.isNotEmpty()) {
                Text(context.tags.joinToString("  ·  "), color = Muted, fontSize = 11.sp)
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = Color(0xFFD9DED9))
            Text(
                if (context.acknowledgements.isEmpty()) "No actor acknowledgements"
                else "Acknowledged by ${context.acknowledgements.joinToString { it.name }}",
                color = if (context.acknowledgements.isEmpty()) Muted else Forest,
                fontSize = 11.sp,
                fontWeight = if (context.acknowledgements.isEmpty()) FontWeight.Normal else FontWeight.Bold,
            )
            Row(
                Modifier.fillMaxWidth().padding(top = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    "#${context.id} · ${context.source ?: "no source"}",
                    color = Muted,
                    fontSize = 11.sp,
                    modifier = Modifier.weight(1f).padding(end = 8.dp),
                )
                Row {
                    TextButton(onClick = onArchive, enabled = context.editable) { Text("Archive") }
                    TextButton(onClick = onDelete, enabled = context.editable) { Text("Delete") }
                    OutlinedButton(
                        onClick = onEdit,
                        enabled = context.editable,
                    ) { Text(if (context.editable) "Edit body" else "Inbox note") }
                }
            }
        }
    }
}

@Composable
private fun ArchiveCard(context: ArchivedContext, restore: () -> Unit) {
    var expanded by remember(context.id) { mutableStateOf(false) }
    val long = context.content.length > 120 || context.content.count { it == '\n' } > 2
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = AmberSoft),
    ) {
        Column(Modifier.padding(18.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(context.actor?.name ?: "Unattributed", fontWeight = FontWeight.Bold)
                Text(formatTime(context.archive.archivedAt), color = Muted, fontSize = 11.sp)
            }
            Text(
                context.content,
                fontFamily = FontFamily.Serif,
                fontSize = 16.sp,
                lineHeight = 23.sp,
                maxLines = if (expanded) Int.MAX_VALUE else 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(vertical = 16.dp),
            )
            if (long) {
                TextButton(onClick = { expanded = !expanded }) {
                    Text(if (expanded) "Show less" else "Show more")
                }
            }
            Label("ARCHIVED BECAUSE")
            Text(context.archive.reason, color = Ink, modifier = Modifier.padding(vertical = 6.dp))
            Text(
                "Archived by ${context.archive.archivedBy.name} · ${formatTime(context.archive.archivedAt)}",
                color = Amber,
                fontSize = 11.sp,
                fontWeight = FontWeight.Bold,
            )
            HorizontalDivider(Modifier.padding(vertical = 12.dp), color = Color(0xFFD9DED9))
            Text(
                if (context.acknowledgements.isEmpty()) "No actor acknowledgements"
                else "Acknowledged by ${context.acknowledgements.joinToString { it.name }}",
                color = if (context.acknowledgements.isEmpty()) Muted else Forest,
                fontSize = 11.sp,
            )
            Row(
                Modifier.fillMaxWidth().padding(top = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text("#${context.id} · ${context.source ?: "no source"}", color = Muted, fontSize = 11.sp)
                OutlinedButton(onClick = restore) { Text("Restore") }
            }
        }
    }
}

@Composable
private fun ArchiveDialog(
    context: WhiteboardContext,
    dismiss: () -> Unit,
    archive: (String) -> Unit,
) {
    var reason by remember(context.id) { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = dismiss,
        title = { Text("Archive context #${context.id}?", fontFamily = FontFamily.Serif) },
        text = {
            Column {
                Text(
                    "The note leaves the active Whiteboard. Your actor identity, this reason, and the note history are retained.",
                    color = Muted,
                    fontSize = 12.sp,
                )
                OutlinedTextField(
                    value = reason,
                    onValueChange = { reason = it },
                    label = { Text("Reason") },
                    placeholder = { Text("Project completed, superseded, no longer active…") },
                    minLines = 4,
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
            }
        },
        confirmButton = {
            Button(onClick = { archive(reason) }, enabled = reason.isNotBlank()) {
                Text("Archive note")
            }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("Keep active") } },
    )
}

@Composable
private fun PrivateChannelCard(channel: PrivateChannel) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(containerColor = ForestSoft),
    ) {
        Column(Modifier.padding(17.dp)) {
            Label("PRIVATE CHANNEL")
            Text(channel.name, fontFamily = FontFamily.Serif, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Text(channel.participants.joinToString(" · ") { it.name }, color = Muted, fontSize = 12.sp)
            Text("${channel.messageCount} message${if (channel.messageCount == 1) "" else "s"}", color = Forest)
        }
    }
}

@Composable
private fun PrivateEnvelopeCard(envelope: PrivateEnvelope) {
    Card(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFFFBFCFA)),
    ) {
        Column(Modifier.padding(16.dp)) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(envelope.sender?.name ?: "Unattributed", fontWeight = FontWeight.Bold)
                Text(formatTime(envelope.createdAt), color = Muted, fontSize = 11.sp)
            }
            Text(envelope.channelName ?: "Direct private message", color = Muted, fontSize = 12.sp)
            Text(
                "Message body withheld",
                color = Amber,
                fontWeight = FontWeight.Bold,
                modifier = Modifier
                    .padding(top = 10.dp)
                    .background(AmberSoft, RoundedCornerShape(8.dp))
                    .padding(horizontal = 9.dp, vertical = 6.dp),
            )
            Text(
                "#${envelope.id} · ${envelope.acknowledgementCount} acknowledgement${if (envelope.acknowledgementCount == 1) "" else "s"}",
                color = Muted,
                fontSize = 10.sp,
                modifier = Modifier.padding(top = 9.dp),
            )
        }
    }
}

@Composable
private fun NoteEditorDialog(
    context: WhiteboardContext?,
    dismiss: () -> Unit,
    save: (String) -> Unit,
) {
    var content by remember(context?.id) { mutableStateOf(context?.content.orEmpty()) }
    var preview by remember(context?.id) { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = dismiss,
        title = {
            Text(
                context?.let { "Edit context #${it.id}" } ?: "Create a Whiteboard note",
                fontFamily = FontFamily.Serif,
            )
        },
        text = {
            Column {
                Text(
                    "Only the note body changes. Routing, attribution, source, and visibility stay server-owned.",
                    color = Muted,
                    fontSize = 12.sp,
                )
                if (preview) {
                    Text(
                        content.ifBlank { "Nothing to preview yet." },
                        fontFamily = FontFamily.Serif,
                        fontSize = 16.sp,
                        lineHeight = 23.sp,
                        modifier = Modifier.fillMaxWidth().padding(top = 20.dp),
                    )
                } else {
                    OutlinedTextField(
                        value = content,
                        onValueChange = { content = it },
                        modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                        minLines = 8,
                    )
                }
                TextButton(onClick = { preview = !preview }) {
                    Text(if (preview) "Back to edit" else "Preview")
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { save(content) },
                enabled = content.isNotBlank(),
            ) { Text(if (context == null) "Create note" else "Save changes") }
        },
        dismissButton = { TextButton(onClick = dismiss) { Text("Cancel") } },
    )
}

private fun formatTime(value: String): String = runCatching {
    DateTimeFormatter.ofPattern("MMM d · h:mm a")
        .withZone(ZoneId.systemDefault())
        .format(Instant.parse(value))
}.getOrDefault(value)
