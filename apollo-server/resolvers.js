import GraphQLJSON from 'graphql-type-json'
import _ from 'lodash';
import {readFileSync} from 'fs'
import {resolve} from 'path'

export default {
  JSON: GraphQLJSON,

  Query: {
    
    // XXX unused, delete
    accounts: (root, args, { db }) => db.get('accounts').value(),

    applicationBlueprint: (root, args, { db }) => {
        //   'The full path of the project, group or namespace, e.g., `gitlab-org/gitlab-foss`.'
        // demo/apostrophe-demo
        return db.get('projects').value()[args.fullPath]
    },

    environments: (root, args, { db }) => {
      const namespace = args.namespace;
      const name = args.name;
      const userdata = db.get('users').value()[namespace];
      let environments = [];
      if (userdata) {
        environments = userdata.environments;
        if (environments) {
          if (name) {
            environments = _.filter(environments, { name });
          }
        }
      }
      return {
        namespace,
        name,
        clientPayload: environments
      }
    },

    resourceTemplates: (root, args, { db }) => {
      // (namespace: String): => ResourceTemplates
    },
  },

  // fields with JSON type need explicit resolvers
  ApplicationBlueprintProject: {
    json: (obj, args, { }) => obj
  }, 
 
  Environments: {
    clientPayload: (obj, args, { }) => obj
  },

  ResourceTemplates: {
    clientPayload: (obj, args, { }) => obj
  },

  Mutation: {

    /*
    deleteResourceTemplate: (root, {fullPath, name}, {db}) => {
      const projectRoot = db.get('projects').value()[fullPath]
      const {ResourceTemplate} = projectRoot
      const isOk  = delete ResourceTemplate[name]

      projectRoot.ResourceTemplate = ResourceTemplate
      db.write()
      return isOk? name: ''
    },
    */


    updateDeploymentObj(root, {projectPath, typename, patch}, {db}) {
      const _patch = typeof(patch) == 'string'? JSON.stringify(patch): patch
      const patchTarget = typename === '*'? db.get('projects').value()[projectPath] : db.get('projects').value()[projectPath][typename]
      console.log(typename, patch)
      if(typename === '*') {
        Object.assign(patchTarget, JSON.parse(readFileSync(resolve(__dirname, 'data', projectPath) + '.json', 'utf-8')))
      } else {
        if(!patchTarget) return {isOk: false, errors: [`Typename '${typename}' does not exist in the target project`]}
        for(let key in patch) {
          if (_patch[key] === null) {
            delete patchTarget[key]
          } else {
            patchTarget[key] = _patch[key]
          }
        }
      }
      db.write()
      return {isOk: true, errors: []}
    },

    updateTemplateResource: (root, { input }, { pubsub, db }) => {
      const { projectPath, title, resourceObject } = input; 
      const overview = db.get('projects').value()[projectPath];      
      const index = _.findIndex(overview['templates'], { title });
      overview['templates'][index]['resource_templates'] = resourceObject;
      db.write();
      return {
          isOk: true,
          resourceObject,
          errors: []
      }
     },
  
    createTemplate: (root, { input }, { pubsub, db }) => { 
      const { projectPath, template } = input;
      const overview = db.get('projects').value()[projectPath];
      const newTemplate = { ...template };
      newTemplate.resource_templates = template.resourceTemplates;
      delete newTemplate.resourceTemplates;
      overview.templates.push(newTemplate);
      db.write();
      return overview.templates;
    },

    removeTemplate: (root, { input }, { pubsub, db }) => {
      const { projectPath, title } = input;
      const overview = db.get('projects').value()[projectPath];
      _.remove(overview['templates'], { title });          
      db.write();
      return  {
        isOk: true,
        templates: overview["templates"]
      }
    },

  /*
    addAccount: ( root, { input }, { pubsub, db }) => {
      const account = {
        id: shortid.generate(),
        account: input.account,
        network: input.network,
        group: input.group,
        resource: input.resource,
        service: input.service,
        emsemble: input.emsemble,
        description: input.description
      }

      db
        .get('accounts')
        .push(account)
        .last()
        .write()

      return account;
    },
*/
  },

  Subscription: {
  },
}
