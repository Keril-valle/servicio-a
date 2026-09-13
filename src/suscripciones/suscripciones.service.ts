import { Injectable } from '@nestjs/common';
import { CreateSuscripcioneDto } from './dto/create-suscripcione.dto';
import { UpdateSuscripcioneDto } from './dto/update-suscripcione.dto';

export interface Suscripcion {
  id: number;
  url: string;
  event: string;
}

@Injectable()
export class SuscripcionesService {
  private readonly suscripciones: Suscripcion[] = [];
  private nextId = 1;

  create(createSuscripcioneDto: CreateSuscripcioneDto) {
    const suscripcion: Suscripcion = {
      id: this.nextId++,
      ...createSuscripcioneDto,
    };

    this.suscripciones.push(suscripcion);
    return suscripcion;
  }

  findAll() {
    return this.suscripciones;
  }

  findOne(id: number) {
    return this.suscripciones.find((suscripcion) => suscripcion.id === id);
  }

  update(id: number, updateSuscripcioneDto: UpdateSuscripcioneDto) {
    const suscripcion = this.findOne(id);
    if (!suscripcion) {
      return undefined;
    }

    Object.assign(suscripcion, updateSuscripcioneDto);
    return suscripcion;
  }

  remove(id: number) {
    const index = this.suscripciones.findIndex((suscripcion) => suscripcion.id === id);
    if (index === -1) {
      return undefined;
    }

    return this.suscripciones.splice(index, 1)[0];
  }

  findByEvent(event: string) {
    return this.suscripciones.filter((suscripcion) => suscripcion.event === event);
  }
}
