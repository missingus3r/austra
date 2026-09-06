/**
 * Script to seed initial donors
 * Run with: node scripts/seed-donors.js
 */

import mongoose from 'mongoose';
import Donor from '../src/models/Donor.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables
dotenv.config({ path: join(__dirname, '..', '.env') });

const initialDonors = [
  {
    name: 'missingus3r',
    amount: 150,
    currency: 'USD',
    date: 'Enero 2025',
    message: 'Creando herramientas que impacten positivamente en la comunidad.',
    isAnonymous: false
  },
  {
    name: 'Donador Anónimo',
    amount: 75,
    currency: 'USD',
    date: 'Enero 2025',
    message: 'Apoyando proyectos que hacen la diferencia.',
    isAnonymous: true
  }
];

async function seedDonors() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/austra';
    console.log('Conectando a MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✓ Conectado a MongoDB');

    // Check if donors already exist
    const existingCount = await Donor.countDocuments();
    if (existingCount > 0) {
      console.log(`\nYa existen ${existingCount} donadores en la base de datos.`);
      const readline = await import('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });

      const answer = await new Promise((resolve) => {
        rl.question('¿Deseas eliminarlos y agregar los donadores iniciales? (s/n): ', resolve);
      });
      rl.close();

      if (answer.toLowerCase() !== 's') {
        console.log('Operación cancelada.');
        process.exit(0);
      }

      // Delete existing donors
      await Donor.deleteMany({});
      console.log('✓ Donadores existentes eliminados');
    }

    // Create initial donors
    console.log('\nCreando donadores iniciales...');
    for (const donorData of initialDonors) {
      const donor = new Donor(donorData);
      await donor.save();
      console.log(`✓ Creado: ${donor.name} - $${donor.amount} ${donor.currency} (${donor.tier})`);
    }

    console.log(`\n✓ ${initialDonors.length} donadores creados exitosamente!`);
    console.log('\nDonadores en la base de datos:');
    const allDonors = await Donor.find().sort({ amount: -1 });
    allDonors.forEach((donor, index) => {
      console.log(`  ${index + 1}. ${donor.name} - $${donor.amount} ${donor.currency} (${donor.tier})`);
    });

  } catch (error) {
    console.error('Error al crear donadores:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\n✓ Conexión cerrada');
    process.exit(0);
  }
}

// Run the seeder
seedDonors();
