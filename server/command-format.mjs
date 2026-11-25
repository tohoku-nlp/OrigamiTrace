// Validation of a model response against knowledge/command_specification.json.
//
// A response is "invalid" when it has no JSON code block, the JSON does not
// parse, or a command does not follow the specification.

// Allow indentation before the closing fence (models sometimes indent the whole block).
const CODE_BLOCK_PATTERN = /```([\w-]*)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

export function validateCommandResponse(text, specification, { allowQuestion = false } = {}) {
  const response = String(text || "").trim();
  if (!response) return invalid("The response is empty.");

  const codeBlocks = [...response.matchAll(CODE_BLOCK_PATTERN)];
  if (!codeBlocks.length) {
    // Task 2 only: a response without a code block may be a clarification
    // question. The instructor decides whether to answer it or to judge it.
    if (allowQuestion && !response.includes("```")) {
      return { valid: true, kind: "question" };
    }
    return invalid("No code block was found in the response.");
  }

  // Models sometimes reason in text or correct themselves across several code
  // blocks. Check from the last block backwards and accept the first valid one.
  for (let index = codeBlocks.length - 1; index >= 0; index -= 1) {
    const result = validateCommandBlock(codeBlocks[index][2], specification);
    if (result.valid) return result;
  }
  return validateCommandBlock(codeBlocks.at(-1)[2], specification);
}

function validateCommandBlock(blockContent, specification) {
  if (!blockContent.trim()) return invalid("The code block is empty.");

  let payload;
  try {
    payload = JSON.parse(blockContent);
  } catch {
    return invalid("The code block does not contain valid JSON.");
  }

  const commands = commandList(payload);
  if (!commands?.length) return invalid("At least one command is required.");

  const schemas = new Map(
    (specification?.commands || []).map((command) => [command.command_name, command]),
  );
  const foldFields = (specification?.fold_info_schema?.required_fields || []).map(
    (field) => field.name,
  );
  for (let index = 0; index < commands.length; index += 1) {
    const error = validateCommand(commands[index], schemas, foldFields);
    if (error) return invalid(`Command ${index + 1}: ${error}`);
  }

  const isFold = (command) => ["fold", "make_crease"].includes(command.command_name);
  return {
    valid: true,
    kind: "command",
    commandCount: commands.length,
    // All fold_infos of fold / make_crease commands, in order (drawn on the image).
    foldInfos: commands.filter(isFold).flatMap((command) =>
      command.parameters.fold_infos.map((foldInfo) => ({
        commandName: command.command_name,
        creaseLineEdge1: foldInfo.crease_line_edge1,
        creaseLineEdge2: foldInfo.crease_line_edge2,
        sourcePoint: foldInfo.source_point,
        targetPoint: foldInfo.target_point,
        foldType: foldInfo.fold_type,
        theta: foldInfo.theta,
        sourceLayers: foldInfo.source_layers,
        pocketPoint: foldInfo.pocket_point,
        destinationLayer: foldInfo.destination_layer,
      })),
    ),
    // Every command in order, for the operation summary.
    operations: commands.map((command) => ({
      commandName: command.command_name,
      foldTypes: isFold(command) ? command.parameters.fold_infos.map((foldInfo) => foldInfo.fold_type) : [],
      rotation:
        command.command_name === "rotate_3d"
          ? {
              thetaX: command.parameters.theta_x,
              thetaY: command.parameters.theta_y,
              thetaZ: command.parameters.theta_z,
            }
          : null,
    })),
  };
}

function commandList(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isObject(payload)) return null;
  if (typeof payload.command_name === "string") return [payload];
  if (Array.isArray(payload.commands)) return payload.commands;
  if (Array.isArray(payload.command)) return payload.command;
  return null;
}

function validateCommand(command, schemas, foldFields) {
  if (!isObject(command)) return "a command must be an object.";
  if (typeof command.command_name !== "string") return "command_name must be a string.";
  const schema = schemas.get(command.command_name);
  if (!schema) return `unknown command_name: ${command.command_name}`;
  if (!isObject(command.parameters)) return "parameters must be an object.";

  for (const parameter of schema.Usage?.required_parameters || []) {
    if (!(parameter.name in command.parameters)) {
      return `parameters.${parameter.name} is missing.`;
    }
    if (!matchesDeclaredType(command.parameters[parameter.name], parameter.type)) {
      return `parameters.${parameter.name} does not have the declared type.`;
    }
  }

  switch (command.command_name) {
    case "fold":
    case "make_crease":
      return validateFoldInfos(command.parameters.fold_infos, foldFields);
    case "rotate_3d":
      return validateRotation(command.parameters);
    case "finish":
      return Object.keys(command.parameters).length === 0
        ? ""
        : "finish takes an empty parameters object.";
    default:
      return "";
  }
}

function validateFoldInfos(foldInfos, requiredFields) {
  if (!Array.isArray(foldInfos) || foldInfos.length === 0) {
    return "fold_infos must be a non-empty array.";
  }
  for (const foldInfo of foldInfos) {
    if (!isObject(foldInfo)) return "each fold_info must be an object.";
    for (const field of requiredFields) {
      if (!(field in foldInfo)) return `fold_info.${field} is missing.`;
    }
    for (const field of ["crease_line_edge1", "crease_line_edge2", "source_point", "target_point"]) {
      if (!isPoint(foldInfo[field])) return `fold_info.${field} must be an array of two numbers.`;
    }
    if (pointsEqual(foldInfo.crease_line_edge1, foldInfo.crease_line_edge2)) {
      return "fold_info.crease_line_edge1 and crease_line_edge2 are the same point.";
    }
    if (!isSourceLayers(foldInfo.source_layers)) {
      return 'fold_info.source_layers must be ["all"] or strictly increasing positive integers (e.g. [1], [1, 2], [2]).';
    }
    if (!isFiniteNumber(foldInfo.theta) || foldInfo.theta < 0 || foldInfo.theta > 180) {
      return "fold_info.theta must be a number between 0 and 180.";
    }
    if (!["valley", "mountain"].includes(foldInfo.fold_type)) {
      return 'fold_info.fold_type must be "valley" or "mountain".';
    }
    const hasPocketPoint = "pocket_point" in foldInfo;
    if (hasPocketPoint !== "destination_layer" in foldInfo) {
      return "fold_info.pocket_point and fold_info.destination_layer must be given together.";
    }
    if (hasPocketPoint) {
      if (!isPoint(foldInfo.pocket_point)) {
        return "fold_info.pocket_point must be an array of two numbers.";
      }
      const destination = foldInfo.destination_layer;
      if (
        !Array.isArray(destination) ||
        destination.length !== 2 ||
        !isPositiveInteger(destination[0]) ||
        !isPositiveInteger(destination[1])
      ) {
        return "fold_info.destination_layer must be an array of two positive integers.";
      }
      if (destination[1] !== destination[0] + 1) {
        return "fold_info.destination_layer must be two consecutive layer numbers.";
      }
    }
  }
  return "";
}

function validateRotation(parameters) {
  for (const axis of ["theta_x", "theta_y", "theta_z"]) {
    const value = parameters[axis];
    if (!isFiniteNumber(value) || value < -180 || value > 180) {
      return `${axis} must be a number between -180 and 180.`;
    }
  }
  return "";
}

function matchesDeclaredType(value, type) {
  if (type === "Number") return isFiniteNumber(value);
  if (type === "Integer") return Number.isInteger(value);
  if (type === "String") return typeof value === "string";
  if (type === "Object") return isObject(value);
  if (type === "List") return Array.isArray(value);
  if (type === "List[Object]") return Array.isArray(value) && value.every(isObject);
  if (type === "List[Number, Number]") return isPoint(value);
  return true;
}

function isPoint(value) {
  return Array.isArray(value) && value.length === 2 && value.every(isFiniteNumber);
}

function pointsEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a[0] - b[0]) < epsilon && Math.abs(a[1] - b[1]) < epsilon;
}

// Layers counted from the top: ["all"], or strictly increasing integers >= 1.
// Moving only lower layers (e.g. [2]) is allowed.
function isSourceLayers(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.length === 1 && value[0] === "all") return true;
  return value.every(
    (layer, index) => Number.isInteger(layer) && layer >= 1 && (index === 0 || layer > value[index - 1]),
  );
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalid(reason) {
  return { valid: false, kind: "invalid", reason };
}
