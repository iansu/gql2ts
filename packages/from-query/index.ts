import {
  parse,
  GraphQLSchema,
  DocumentNode,
  GraphQLField,
  GraphQLCompositeType,
  isCompositeType,
  getNamedType,
  GraphQLType,
  VariableDefinitionNode,
  TypeNode,
  OperationTypeNode,
  GraphQLObjectType,
  GraphQLEnumType,
  DirectiveNode,
  GraphQLInputObjectType,
  GraphQLInputField,
  GraphQLUnionType,
  GraphQLNamedType,
} from 'graphql';
import {
  schemaFromInputs,
  isList,
  isNonNullable,
} from '@gql2ts/util';
import {
  ChildSelectionsType,
  IChildren,
  IComplexTypeSignature,
  IOptions,
  Signature,
  RegularTypeSignature,
  VariableTypeSignature,
  convertToTypeSignature,
  ITypeMap
} from './types';
import { DEFAULT_TYPE_MAP, DEFAULT_OPTIONS } from './defaults';

const doIt: Signature = (schema, query, typeMap= {}, providedOptions= {}) => {
  const TypeMap: ITypeMap = {
    ...DEFAULT_TYPE_MAP,
    ...typeMap
  };

  const options: IOptions = {
    ...DEFAULT_OPTIONS,
    ...providedOptions
  };

  const {
    buildRootInterfaceName,
    formatFragmentInterface,
    formatInterface,
    formatVariableInterface,
    wrapList,
    wrapPartial,
    generateSubTypeInterfaceName,
    printType,
    formatInput,
    generateFragmentName,
    generateQueryName,
  }: IOptions = options;

  const parsedSchema: GraphQLSchema = schemaFromInputs(schema);
  const parsedSelection: DocumentNode = parse(query);

  const handleInputObject: (type: GraphQLInputObjectType, isNonNull: boolean) => string = (type, isNonNull) => {
    const variables: GraphQLInputField[] = Object.keys(type.getFields()).map(k => type.getFields()[k]);
    // tslint:disable-next-line no-use-before-declare
    const variableDeclarations: string = variables.map(v => formatInput(v.name, true, convertToType(v.type))).join('\n    ');
    const builder: string = `{\n    ${variableDeclarations}\n  }`;
    return printType(builder, isNonNull);
  };

  const handleEnum: (type: GraphQLEnumType, isNonNull: boolean) => string = (type, isNonNull) => {
    const decl: string = type.getValues().map(en => `'${en.value}'`).join(' | ');
    return printType(decl, isNonNull);
  };

  const handleNamedTypeInput: (type: TypeNode, isNonNull: boolean) => string | undefined = (type, isNonNull) => {
    if (type.kind === 'NamedType' && type.name.kind === 'Name' && type.name.value) {
      const newType: GraphQLType = parsedSchema.getType(type.name.value);
      if (newType instanceof GraphQLEnumType) {
        return handleEnum(newType, isNonNull);
      } else if (newType instanceof GraphQLInputObjectType) {
        return handleInputObject(newType, isNonNull);
      }
    }
  };

  const handleRegularType: RegularTypeSignature = (type, isNonNull, replacement) => {
    const typeValue: string = (typeof type.name === 'string') ? type.toString() : type.name.value;
    const showValue: string = replacement || typeValue;
    const show: string = TypeMap[showValue] || (replacement ? showValue : TypeMap.__DEFAULT);
    return printType(show, isNonNull);
  };

  const convertVariable: VariableTypeSignature = (type, isNonNull= false, replacement= null) => {
    if (type.kind === 'ListType') {
      return printType(wrapList(convertVariable(type.type, false, replacement)), isNonNull!);
    } else if (type.kind === 'NonNullType') {
      return convertVariable(type.type, true, replacement);
    } else {
      return handleNamedTypeInput(type, isNonNull!) || handleRegularType(type, isNonNull!, replacement!);
    }
  };

  const convertToType: convertToTypeSignature = (type, isNonNull= false, replacement= null): string => {
    if (isList(type)) {
      return printType(wrapList(convertToType(type.ofType, false, replacement)), isNonNull!);
    } else if (isNonNullable(type)) {
      return convertToType(type.ofType, true, replacement);
    } else if (type instanceof GraphQLEnumType) {
      return handleEnum(type, isNonNull!);
    } else {
      return handleRegularType(type, isNonNull!, replacement!);
    }
  };

  const UndefinedDirectives: Set<string> = new Set(['include', 'skip']);

  const isUndefinedFromDirective: (directives: DirectiveNode[] | undefined) => boolean = directives => {
    if (!directives || !directives.length) { return false; }

    const badDirectives: DirectiveNode[] = directives.filter(d => !UndefinedDirectives.has(d.name.value));
    const hasDirectives: boolean = directives.some(d => UndefinedDirectives.has(d.name.value));

    if (badDirectives.length) {
      console.error('Found some unknown directives:');
      badDirectives.forEach(d => console.error(d.name.value));
    }

    return hasDirectives;
  };

  const getOperationFields: (operation: OperationTypeNode) => GraphQLObjectType = operation => {
    switch (operation) {
      case 'query':
        return parsedSchema.getQueryType();
      case 'mutation':
        return parsedSchema.getMutationType();
      case 'subscription':
        return parsedSchema.getSubscriptionType();
      default:
        throw new Error('Unsupported Operation');
    }
  };

  const wrapPossiblePartial: (possiblePartial: IChildren) => string = possiblePartial => {
    if (possiblePartial.isPartial) {
      return wrapPartial(possiblePartial.iface);
    } else {
      return possiblePartial.iface;
    }
  };

  const flattenComplexTypes: (children: IChildren[]) => IComplexTypeSignature[] = children => (
    children.reduce((acc, child) => { acc.push(...child.complexTypes); return acc; }, [] as IComplexTypeSignature[])
  );

  const getChildSelections: ChildSelectionsType = (operation, selection, indentation= '', parent?, isUndefined= false): IChildren => {
    let str: string = '';
    let field: GraphQLField<any, any>;
    let isFragment: boolean = false;
    let isPartial: boolean = false;
    let generatedTypeCount: number = 0;
    let complexTypes: IComplexTypeSignature[] = [];

    if (selection.kind === 'Field') {
      if (parent && isCompositeType(parent)) {
        if (parent instanceof GraphQLUnionType) {
          field = parent.getTypes().map(t => t.getFields()[selection.name.value]).find(z => !!z)!;
        } else {
          field = parent.getFields()[selection.name.value];
        }
      } else {
        const operationFields: GraphQLObjectType = getOperationFields(operation);
        field = operationFields.getFields()[selection.name.value];
      }

      const selectionName: string = selection.alias ? selection.alias.value : selection.name.value;
      isUndefined = isUndefined || isUndefinedFromDirective(selection.directives);

      let resolvedType: string = '';
      let childType: string | undefined;

      if (!!selection.selectionSet) {
        let newParent: GraphQLCompositeType | undefined;
        if (!field) { console.log(selection, newParent); }
        const fieldType: GraphQLNamedType = getNamedType(field.type);
        if (isCompositeType(fieldType)) {
          newParent = fieldType;
        }

        const selections: IChildren[] =
          selection.selectionSet.selections.map(sel => getChildSelections(operation, sel, indentation + '  ',  newParent));

        const nonFragments: IChildren[] = selections.filter(s => !s.isFragment);
        const fragments: IChildren[] = selections.filter(s => s.isFragment);
        const andOps: string[] = [];

        complexTypes.push(...flattenComplexTypes(selections));

        if (nonFragments.length) {
          const nonPartialNonFragments: IChildren[] = nonFragments.filter(nf => !nf.isPartial);
          const partialNonFragments: IChildren[] = nonFragments.filter(nf => nf.isPartial);

          if (nonPartialNonFragments.length) {
            let builder: string = '';
            builder += '{\n';
            builder += nonPartialNonFragments.map(f => f.iface).join('\n');
            builder += `\n${indentation}}`;
            const newInterfaceName: string | null = generateSubTypeInterfaceName(selection.name.value, generatedTypeCount);
            if (!newInterfaceName) {
              andOps.push(builder);
            } else {
              andOps.push(newInterfaceName);
            }
            generatedTypeCount += 1;
            complexTypes.push({ iface: builder, isPartial: false, name: newInterfaceName });
          }

          if (partialNonFragments.length) {
            let builder: string = '';
            builder += '{\n';
            builder += partialNonFragments.map(f => f.iface).join('\n');
            builder += `\n${indentation}}`;
            builder = wrapPartial(builder);
            andOps.push(builder);
            const newInterfaceName: string = generateSubTypeInterfaceName(selection.name.value, generatedTypeCount);
            generatedTypeCount += 1;
            complexTypes.push({ iface: builder, isPartial: true, name: newInterfaceName });
          }
        }

        if (fragments.length) {
          andOps.push(...fragments.map(wrapPossiblePartial));
        }

        childType = andOps.join(' & ');
      }
      resolvedType = convertToType(field.type, false, childType);
      str = formatInput(indentation + selectionName, isUndefined, resolvedType);
    } else if (selection.kind === 'FragmentSpread') {
      str = generateFragmentName(selection.name.value);
      isFragment = true;
      isPartial = isUndefinedFromDirective(selection.directives);
    } else if (selection.kind === 'InlineFragment') {
      const anon: boolean = !selection.typeCondition;
      if (!anon) {
        const typeName: string = selection.typeCondition!.name.value;
        parent = parsedSchema.getType(typeName);
      }

      const selections: IChildren[] =
        selection.selectionSet.selections.map(sel => getChildSelections(operation, sel, indentation, parent, !anon));

      let joinSelections: string = selections.map(s => s.iface).join('\n');
      isPartial = isUndefinedFromDirective(selection.directives);

      return {
        iface: joinSelections,
        isFragment,
        isPartial,
        complexTypes,
      };

    } else {
      throw new Error('Unsupported SelectionNode');
    }
    return {
      iface: str,
      isFragment,
      isPartial,
      complexTypes,
    };
  };

  const getVariables: (variables: VariableDefinitionNode[]) => string[] = variables => (
    variables.map(v => {
      const optional: boolean = v.type.kind !== 'NonNullType';
      const type: string = convertVariable(v.type);
      return formatInput(v.variable.name.value, optional, type);
    })
  );

  const variablesToInterface: (operationName: string, variables: VariableDefinitionNode[] | undefined) => string = (opName, variables) => {
    if (!variables || !variables.length) { return ''; }
    const variableTypeDefs: string[] = getVariables(variables);
    return formatVariableInterface(opName, variableTypeDefs);
  };

  const buildAdditionalTypes: (children: IChildren[]) => string[] = children => {
    const subTypes: IComplexTypeSignature[] = flattenComplexTypes(children);

    return subTypes.map(subtype => {
      if (subtype.isPartial) {
        return `export type ${subtype.name} = ${subtype.iface};`;
      } else {
        return `export interface ${subtype.name} ${subtype.iface}`;
      }
    });
  };

  return parsedSelection.definitions.map(def => {
    const ifaceName: string = buildRootInterfaceName(def, generateQueryName, generateFragmentName);
    if (def.kind === 'OperationDefinition') {
      const variableInterface: string = variablesToInterface(ifaceName, def.variableDefinitions);
      const ret: IChildren[] = def.selectionSet.selections.map(sel => getChildSelections(def.operation, sel, '  '));
      const fields: string[] = ret.map(x => x.iface);
      const iface: string = formatInterface(ifaceName, fields);
      const additionalTypes: string[] = buildAdditionalTypes(ret);

      return {
        variables: variableInterface,
        interface: iface,
        additionalTypes,
      };
    } else if (def.kind === 'FragmentDefinition') {
      // get the correct type
      const onType: string = def.typeCondition.name.value;
      const foundType: GraphQLType = parsedSchema.getType(onType);

      const ret: IChildren[] = def.selectionSet.selections.map(sel => getChildSelections('query', sel, '  ', foundType));
      const extensions: string[] = ret.filter(x => x.isFragment).map(x => x.iface);
      const fields: string[] = ret.filter(x => !x.isFragment).map(x => x.iface);
      const iface: string = formatFragmentInterface(ifaceName, fields, extensions);
      const additionalTypes: string[] = buildAdditionalTypes(ret);

      return {
        interface: iface,
        variables: '',
        additionalTypes,
      };
    } else {
      throw new Error(`Unsupported Definition ${def.kind}`);
    }
  });
};

export default doIt;
