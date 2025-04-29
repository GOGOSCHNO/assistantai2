require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const mongoose = require('mongoose');
const OpenAI = require("openai");
const { MongoClient } = require('mongodb');
const twilio = require('twilio');
const axios = require('axios');
const { google } = require('googleapis'); // Peut être supprimé

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Exemple de token stocké en variable d'env (ou config)
const token = process.env.WHATSAPP_CLOUD_API_TOKEN || "TON_TOKEN_PERMANENT";
const whatsappPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID || "TON_PHONE_NUMBER_ID";

// Configuration MongoDB
const mongoUri = process.env.MONGODB_URI;
if (!mongoUri) {
    console.error("❌ Erreur : MONGODB_URI n'est pas défini dans les variables d'environnement.");
    process.exit(1);
}

let db;  // Variable pour stocker la connexion à MongoDB

async function connectToMongoDB() {
  try {
    const mongoClient = new MongoClient(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
    await mongoClient.connect();
    db = mongoClient.db('chatbotDB');
    console.log("✅ Connecté à MongoDB avec succès !");
  } catch (err) {
    console.error("❌ Erreur lors de la connexion à MongoDB :", err);
    process.exit(1);
  }
}

// Appel de la connexion MongoDB
connectToMongoDB();

// Middleware
app.use(cors({
  origin: 'https://www.puravivecoach.com', // Remplace par l'URL de ton front-end si nécessaire
  credentials: true
}));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser());
app.use(express.json()); // parse le JSON entrant de Meta

// Exportation de `db` pour pouvoir l'utiliser ailleurs
module.exports = { db };

let calendar;

// Fonction pour récupérer ou créer un thread
async function getOrCreateThreadId(userNumber) {
  try {
    const collection = db.collection('threads2');
    let thread = await collection.findOne({ userNumber });
    if (!thread) {
      const threadResponse = await openai.beta.threads.create();
      const threadId = threadResponse.id;

      await collection.insertOne({ userNumber, threadId, responses: [] });
      return threadId;
    }
    return thread.threadId;
  } catch (error) {
    console.error('Erreur lors de la récupération ou création du thread:', error);
    throw error;
  }
}

// Fonction pour interagir avec OpenAI
async function interactWithAssistant(userMessage, userNumber) {
    if (!userMessage || userMessage.trim() === "") {
      throw new Error("Le contenu du message utilisateur est vide ou manquant.");
    }
  
    try {
      const threadId = await getOrCreateThreadId(userNumber);
      const dateISO = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bogota' });
      const heure = new Date().toLocaleTimeString('es-ES', { timeZone: 'America/Bogota' });

      console.log("📅 Date envoyée à l'assistant (ISO) :", dateISO);
  
      // Envoi du message utilisateur à OpenAI
      await openai.beta.threads.messages.create(threadId, {
        role: "user",
        content: `Mensaje del cliente: "${userMessage}". Nota: El número WhatsApp del cliente es ${userNumber}. Fecha actual: ${dateISO} Hora actual: ${heure}`
      });
  
      // Création d'un nouveau "run" pour générer la réponse
      const runResponse = await openai.beta.threads.runs.create(threadId, {
        assistant_id: "asst_aH2eDHwU2aIIUGjYNAi9h44T" // Remplace par ton assistant_id
      });
  
      const runId = runResponse.id;
      // Attente de la fin du run ou d'un éventuel function calling
      const messages = await pollForCompletion(threadId, runId);
  
      console.log("📩 Messages reçus de l'assistant :", messages);
  
      // Sauvegarde des messages et du thread dans MongoDB
      if (messages) {
        const collection = db.collection('threads2');
        await collection.updateOne(
          { userNumber },
          {
            $set: { threadId },
            $push: {
              responses: {
                userMessage,
                assistantResponse: {
                  text: messages.text,
                  note: messages.note // ✅ ici on stocke la note !
                },
                timestamp: new Date()
              }
            }
          },
          { upsert: true }
        );
      }
  
      return messages;
    } catch (error) {
      console.error("❌ Erreur lors de l'interaction avec l'assistant:", error);
      throw error;
    }
  }  
async function initGoogleCalendarClient() {
    try {
      const serviceAccountJson = process.env.SERVICE_ACCOUNT_KEY; 
      if (!serviceAccountJson) {
        console.error("SERVICE_ACCOUNT_KEY n'est pas défini en variable d'env.");
        return;
      }
      const key = JSON.parse(serviceAccountJson);
      console.log("Compte de service :", key.client_email);
  
      const client = new google.auth.JWT(
        key.client_email,
        null,
        key.private_key,
        ['https://www.googleapis.com/auth/calendar']
      );
      
      await client.authorize();
      calendar = google.calendar({ version: 'v3', auth: client });
      console.log('✅ Client Google Calendar initialisé');
    } catch (error) {
      console.error("❌ Erreur d'init du client Google Calendar :", error);
    }
  }

  async function startCalendar() {
    await initGoogleCalendarClient();  // on attend l'init
    if (calendar) {
      try {
        const res = await calendar.calendarList.list();
        console.log('\n📅 Agendas disponibles :');
        (res.data.items || []).forEach(cal => {
          console.log(`- ID: ${cal.id}, Summary: ${cal.summary}`);
        });
      } catch (err) {
        console.error("❌ Erreur listCalendars():", err);
      }
    }
  }
  async function startCalendar() {
    await initGoogleCalendarClient();  // on attend l'init
    if (calendar) {
      await listCalendars();           // maintenant, calendar est défini
    }
  }
  
  // Appeler une seule fois :
  startCalendar();

  async function createAppointment(params) {
    // Vérifier si le client Google Calendar est déjà initialisé
    if (!calendar) {
      try {
        const serviceAccountJson = process.env.SERVICE_ACCOUNT_KEY;
        if (!serviceAccountJson) {
          console.error("SERVICE_ACCOUNT_KEY n'est pas défini en variable d'env.");
          return { success: false, message: "Service account non configuré." };
        }
        const key = JSON.parse(serviceAccountJson);
        console.log("Compte de service :", key.client_email);
  
        // Création du client JWT
        const client = new google.auth.JWT(
          key.client_email,
          null,
          key.private_key,
          ['https://www.googleapis.com/auth/calendar']
        );
  
        // Authentification
        await client.authorize();
  
        // Initialisation du client Calendar et affectation à la variable globale
        calendar = google.calendar({ version: 'v3', auth: client });
        console.log('✅ Client Google Calendar initialisé dans createAppointment');
      } catch (error) {
        console.error("❌ Erreur lors de l'initialisation de Google Calendar :", error);
        return { success: false, message: "Erreur d'initialisation de Calendar" };
      }
    }
  
    // À partir d'ici, calendar est garanti d'être défini.
    try {
      // Définir l'événement à créer
      const event = {
        summary: `Cita de ${params.customerName}`,
        description: `Téléphone: ${params.phoneNumber}\nService: ${params.service}`,
        start: {
          dateTime: `${params.date}T${params.startTime}:00`, // Ajout des secondes si besoin
          timeZone: 'America/Bogota',
        },
        end: {
          dateTime: `${params.date}T${params.endTime}:00`,
          timeZone: 'America/Bogota',
        },
      };  
  
      // Insertion de l'événement dans l'agenda de diegodfr75@gmail.com
      const calendarRes = await calendar.events.insert({
        calendarId: 'diegodfr75@gmail.com',
        resource: event,
      });
  
      const eventId = calendarRes.data.id;
      console.log('Événement créé sur Google Calendar, eventId =', eventId);
  
      // Insertion en base de données (MongoDB) avec l'eventId
      await db.collection('appointments').insertOne({
        customerName: params.customerName,
        phoneNumber: params.phoneNumber,
        date: params.date,
        startTime: params.startTime,
        endTime: params.endTime,
        service: params.service,
        googleEventId: eventId
      });
  
      return { success: true, message: 'Cita creada en Calendar y Mongo', eventId };
    } catch (error) {
      console.error("Erreur lors de la création de l'événement :", error);
      return { success: false, message: 'No se pudo crear la cita.' };
    }
  }
  
  
  async function cancelAppointment(phoneNumber) {
    try {
      // 1) Trouver le RDV en base
      const appointment = await db.collection('appointments')
                                  .findOne({ phonenumber: phoneNumber });
      if (!appointment) {
        console.log("Aucun RDV trouvé pour ce phoneNumber:", phoneNumber);
        return false;
      }
  
      // 2) Supprimer l’event côté Google si googleEventId existe
      if (appointment.googleEventId) {
        await calendar.events.delete({
          calendarId: 'diegodfr75@gmail.com',
          eventId: appointment.googleEventId
        });
        console.log("Événement GoogleCalendar supprimé:", appointment.googleEventId);
      } else {
        console.log("Aucun googleEventId stocké, on ne supprime rien sur Google.");
      }
  
      // 3) Supprimer en base
      const result = await db.collection('appointments').deleteOne({ _id: appointment._id });
      return result.deletedCount > 0;
    } catch (error) {
      console.error("Erreur cancelAppointment:", error);
      return false;
    }
  }

async function enviarAlertaComerciante(estado, numeroCliente) {
  const numeroComerciante = "573009016472"; // numéro fixe
  const apiUrl = `https://graph.facebook.com/v18.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const headers = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    "Content-Type": "application/json"
  };

  const messageData = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: numeroComerciante,
    type: "template",
    template: {
      name: "alerta",  // le modèle que tu as validé
      language: {
        policy: "deterministic",
        code: "es"
      },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: estado },        // correspond à {{1}}
            { type: "text", text: numeroCliente }  // correspond à {{2}}
          ]
        }
      ]
    }
  };

  try {
    await axios.post(apiUrl, messageData, { headers });
    console.log("✅ Alerta enviada al comerciante:", numeroComerciante);
  } catch (err) {
    console.error("❌ Error al enviar alerta al comerciante:", err.response?.data || err.message);
  }
}

async function pollForCompletion(threadId, runId) {
  return new Promise((resolve, reject) => {
    const interval = 2000;
    const timeoutLimit = 80000;
    let elapsedTime = 0;

    const checkRun = async () => {
      try {
        const runStatus = await openai.beta.threads.runs.retrieve(threadId, runId);
        console.log(`📊 Estado del run: ${runStatus.status}`);

        if (runStatus.status === 'completed') {
          const messages = await fetchThreadMessages(threadId);
          console.log("📩 Réponse finale de l'assistant:", messages);
          resolve(messages);
          return;
        }

        if (
          runStatus.status === 'requires_action' &&
          runStatus.required_action?.submit_tool_outputs?.tool_calls
        ) {
          const toolCalls = runStatus.required_action.submit_tool_outputs.tool_calls;
          const toolOutputs = [];

          for (const toolCall of toolCalls) {
            const { function: fn, id } = toolCall;
            let params;

            try {
              params = JSON.parse(fn.arguments);
            } catch (error) {
              console.error("❌ Erreur en parsant les arguments JSON:", error);
              reject(error);
              return;
            }

            switch (fn.name) {
              case "getAppointments": {
                const appointments = await db.collection("appointments")
                                            .find({ date: params.date })
                                            .toArray();

                toolOutputs.push({
                  tool_call_id: id,
                  output: JSON.stringify(appointments),
                });
                break;
              }

              case "cancelAppointment": {
                const wasDeleted = await cancelAppointment(params.phoneNumber);

                toolOutputs.push({
                  tool_call_id: id,
                  output: JSON.stringify({
                    success: wasDeleted,
                    message: wasDeleted
                      ? "La cita ha sido cancelada."
                      : "No se encontró ninguna cita para ese número."
                  })
                });
                break;
              }

              case "createAppointment": {
                const result = await createAppointment(params);

                toolOutputs.push({
                  tool_call_id: id,
                  output: JSON.stringify({
                    success: result.success,
                    message: result.message
                  })
                });
                break;
              }

              case "get_image_url": {
                console.log("🖼️ Demande d'URL image reçue:", params);
                const imageUrl = await getImageUrl(params.imageCode);

                toolOutputs.push({
                  tool_call_id: id,
                  output: JSON.stringify({ imageUrl })
                });
                break;
              }

              case "notificar_comerciante": {
                console.log("📣 Function calling détectée : notificar_comerciante");
                const { estado, numero_cliente } = params;
                await enviarAlertaComerciante(estado, numero_cliente);
                toolOutputs.push({
                  tool_call_id: id,
                  output: JSON.stringify({ success: true })
                });
                break;
              }

              default:
                console.warn(`⚠️ Fonction inconnue (non gérée) : ${fn.name}`);
            }
          }

          if (toolOutputs.length > 0) {
            await openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
              tool_outputs: toolOutputs
            });
          }

          setTimeout(checkRun, 500);
          return;
        }

        elapsedTime += interval;
        if (elapsedTime >= timeoutLimit) {
          console.error("⏳ Timeout (80s), annulation du run...");
          await openai.beta.threads.runs.cancel(threadId, runId);
          reject(new Error("Run annulé après 80s sans réponse."));
          return;
        }

        setTimeout(checkRun, interval);

      } catch (error) {
        console.error("Erreur dans pollForCompletion:", error);
        reject(error);
      }
    };

    checkRun();
  });
}

// Récupérer les messages d'un thread
async function fetchThreadMessages(threadId) {
  try {
    const messagesResponse = await openai.beta.threads.messages.list(threadId);
    const messages = messagesResponse.data.filter(msg => msg.role === 'assistant');

    const latestMessage = messages[0];
    let textContent = latestMessage.content
      .filter(c => c.type === 'text')
      .map(c => c.text.value)
      .join(" ");

    // Extraction des URLs Markdown du texte
    const markdownUrlRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
    let match;
    const markdownImageUrls = [];

    while ((match = markdownUrlRegex.exec(textContent)) !== null) {
      markdownImageUrls.push(match[1]);
    }

    // Nettoyage des URL markdown du texte
    textContent = textContent.replace(markdownUrlRegex, '').trim();

    // Suppression des références internes 【XX:XX†nomfichier.json】
    textContent = textContent.replace(/【\d+:\d+†[^\]]+】/g, '').trim();

    // ➕ Détection et extraction de la nota interna
    let summaryNote = null;
    let statusNote = null;

    const noteStart = textContent.indexOf('--- Nota interna ---');
    if (noteStart !== -1) {
      const noteContent = textContent.slice(noteStart).replace(/[-]+/g, '').trim();

      const resumenMatch = noteContent.match(/Resumen\s*:\s*(.+)/i);
      const estadoMatch = noteContent.match(/Estado\s*:\s*(.+)/i);

      summaryNote = resumenMatch ? resumenMatch[1].trim() : null;
      statusNote = estadoMatch ? estadoMatch[1].trim() : null;

      // Supprimer la note du texte envoyé au client
      textContent = textContent.slice(0, noteStart).trim();
    }

    // ➕ Conversion Markdown OpenAI → Markdown WhatsApp
    function convertMarkdownToWhatsApp(text) {
      return text
        .replace(/\*\*(.*?)\*\*/g, '*$1*')          // Gras
        .replace(/\*(.*?)\*/g, '_$1_')              // Italique
        .replace(/~~(.*?)~~/g, '~$1~')              // Barré
        .replace(/!\[.*?\]\((.*?)\)/g, '')          // Images
        .replace(/\[(.*?)\]\((.*?)\)/g, '$1 : $2')  // Liens
        .replace(/^>\s?(.*)/gm, '$1')               // Citations
        .replace(/^(\d+)\.\s/gm, '- ')              // Listes
        .trim();
    }

    // Application de la conversion Markdown
    textContent = convertMarkdownToWhatsApp(textContent);

    // Récupération des images issues du Function Calling
    const toolMessages = messagesResponse.data.filter(msg => msg.role === 'tool');
    const toolImageUrls = toolMessages
      .map(msg => msg.content?.[0]?.text?.value)
      .filter(url => url && url.startsWith('http'));

    const images = [...markdownImageUrls, ...toolImageUrls];

    // ✅ Retour complet avec note extraite
    return {
      text: textContent,
      images: images,
      note: {
        summary: summaryNote,
        status: statusNote
      }
    };

  } catch (error) {
    console.error("Erreur lors de la récupération des messages du thread:", error);
    return {
      text: "",
      images: [],
      note: null
    };
  }
}

// Fonction pour récupérer les URLs des images depuis MongoDB
async function getImageUrl(imageCode) {
  try {
    const image = await db.collection("images").findOne({ _id: imageCode });

    if (image && image.url) {
      console.log(`✅ URL trouvée pour le code "${imageCode}" : ${image.url}`);
    } else {
      console.warn(`⚠️ Aucune URL trouvée pour le code "${imageCode}".`);
    }

    return image ? image.url : null;
  } catch (error) {
    console.error("❌ Erreur récupération URL image:", error);
    return null;
  }
}

// Modification du endpoint WhatsApp pour gérer les images
app.post('/whatsapp', async (req, res) => {
  console.log('📩 Requête reçue :', JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const field = changes?.field;

    // 🚫 Ignorer les événements qui ne sont pas de type "messages"
    if (field !== "messages" || !value.messages || !value.messages[0]) {
      return res.status(200).send("Pas un message entrant à traiter.");
    }

    const message = value.messages[0];
    const from = message.from;
    const phoneNumberId = value.metadata.phone_number_id;
    const messageId = message.id;

    // ✅ Vérifier si ce message a déjà été traité
    const alreadyProcessed = await db.collection('processedMessages').findOne({ messageId });
    if (alreadyProcessed) {
      console.log("⚠️ Message déjà traité, on ignore :", messageId);
      return res.status(200).send("Message déjà traité.");
    }
    await db.collection('processedMessages').insertOne({ messageId });

    // 🧠 Extraire le contenu utilisateur
    let userMessage = '';
    if (message.type === 'text' && message.text.body) {
      userMessage = message.text.body.trim();
    } else if (message.type === 'image') {
      userMessage = "Cliente envió una imagen.";
    } else if (message.type === 'audio') {
      userMessage = "Cliente envió un audio.";
    } else {
      userMessage = "Cliente envió un type de message non géré.";
    }

    if (!userMessage) {
      return res.status(200).send('Message vide ou non géré.');
    }

    // 🔄 Envoyer le message à l’assistant
    const response = await interactWithAssistant(userMessage, from);
    console.log("🧠 Réponse de l'assistant :", response);
    const { text, images } = response;

    // 📤 Répondre via l'API WhatsApp Cloud
    const apiUrl = `https://graph.facebook.com/v16.0/${phoneNumberId}/messages`;
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 🗣️ Envoi du texte
    if (text) {
      await axios.post(
        apiUrl,
        {
          messaging_product: 'whatsapp',
          to: from,
          text: { body: text },
        },
        { headers }
      );
    }

    // 🖼️ Envoi des images (fonction calling ou markdown)
    if (images && images.length > 0) {
      for (const url of images) {
        if (url) {
          console.log("📤 Envoi de l’image :", url);
          
          await axios.post(
            apiUrl,
            {
              messaging_product: 'whatsapp',
              to: from,
              type: 'image',
              image: { link: url },
            },
            { headers }
          );
        }
      }
    }

    res.status(200).send('Message traité avec succès.');

  } catch (error) {
    console.error("❌ Erreur lors du traitement du message WhatsApp :", error);
    res.status(500).json({ error: "Erreur serveur." });
  }
});

app.get('/whatsapp', (req, res) => {
  // Récupère les paramètres que Meta envoie
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Compare le token reçu avec celui que vous avez défini dans Meta for Developers
  if (mode === 'subscribe' && token === 'myVerifyToken123') {
    console.log('WEBHOOK_VERIFIED');
    // Renvoyer challenge pour confirmer la vérification
    res.status(200).send(challenge);
  } else {
    // Token ou mode invalide
    res.sendStatus(403);
  }
});

// Endpoint de vérification
app.get('/', (req, res) => {
  res.send('Le serveur est opérationnel !');
});

// Lancer le serveur
app.listen(PORT, () => {
  console.log(`Le serveur fonctionne sur le port ${PORT}`);
});
